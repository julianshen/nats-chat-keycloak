/**
 * E2EEKeyManager — NATS protocol layer for end-to-end encryption key distribution.
 *
 * Handles:
 *   - Identity key initialization and publication to e2ee-key-service
 *   - Room metadata fetching and caching
 *   - Key request handling (acting as distributor for new members)
 *   - Key rotation when members leave E2EE rooms
 *   - Message encrypt/decrypt using room keys from E2EEManager
 *
 * Crypto primitives are delegated to E2EEManager. This class only handles the NATS protocol.
 */

import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import type { E2EERoomMeta, DecryptResult, ChatMessage } from './types';
import {
  getOrCreateIdentityKey,
  importPublicKey,
  generateRoomKey,
  exportRoomKeyRaw,
  storeRoomKey,
  getRoomKey,
  wrapRoomKeyForRecipient,
  unwrapRoomKey,
  encryptText,
  decryptText,
} from '../E2EEManager';

type E2EEKeyManagerEvents = {
  ready: () => void;
  roomEnabled: (room: string) => void;
  keyRotated: (room: string, epoch: number) => void;
  initError: (error: string) => void;
};

// Internal room meta shape matching E2EEProvider's RoomE2EEMeta
interface InternalRoomMeta {
  enabled: boolean;
  currentEpoch: number;
  initiator?: string;
}

export interface EnableE2EEResult {
  ok: boolean;
  failedMembers: string[];
}

export class E2EEKeyManager extends TypedEmitter<E2EEKeyManagerEvents> {
  private cm: ConnectionManager;
  private username: string;

  private _ready = false;
  private identityKey: { privateKey: CryptoKey; publicKey: CryptoKey; publicKeyJwk: JsonWebKey } | null = null;
  private roomMetaMap: Map<string, InternalRoomMeta> = new Map();
  private metaFetchErrors: Set<string> = new Set();
  private subscriptions: Array<{ unsubscribe: () => void }> = [];
  private broadcastChannel: BroadcastChannel | null = null;

  constructor(cm: ConnectionManager, username: string) {
    super();
    this.cm = cm;
    this.username = username;
    this._startBroadcastChannelListener();
  }

  get isReady(): boolean {
    return this._ready;
  }

  private async publishIdentityWithRetry(nc: NonNullable<ConnectionManager['nc']>, payload: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const maxAttempts = 6;
    const baseDelayMs = 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const pubReply = await nc.request(`e2ee.identity.publish.${this.username}`, sc.encode(payload), {
          timeout: 5000,
        });
        const pubResult = JSON.parse(sc.decode(pubReply.data));
        if (pubResult.error) {
          return { ok: false, error: `E2EE identity publish rejected: ${pubResult.error}` };
        }
        return { ok: true };
      } catch (pubErr) {
        if (attempt < maxAttempts) {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          console.warn(`[E2EEKeyManager] Identity publish attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`, pubErr);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }
    return { ok: false, error: 'E2EE unavailable: identity key publish failed' };
  }

  /**
   * Initialize identity key (generate or load from IndexedDB) and publish to e2ee-key-service.
   * Also starts NATS subscriptions for key rotation and key distribution requests.
   * Emits `ready` on success or `initError` on failure.
   */
  async init(): Promise<void> {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) {
      this.emit('initError', 'E2EE unavailable: not connected');
      return;
    }

    try {
      const identity = await getOrCreateIdentityKey(this.username);
      this.identityKey = identity;

      // Publish public key to e2ee-key-service
      const payload = JSON.stringify({
        username: this.username,
        publicKey: identity.publicKeyJwk,
      });

      const publish = await this.publishIdentityWithRetry(nc, payload);
      if (!publish.ok) {
        console.error('[E2EEKeyManager] Identity key publish failed:', publish.error);
        this.emit('initError', publish.error);
        return;
      }
      console.log('[E2EEKeyManager] Identity key initialized and published');

      this._ready = true;
      this.emit('ready');

      // Start NATS subscriptions now that we're ready
      this._startSubscriptions();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[E2EEKeyManager] Failed to initialize identity key:', err);
      this.emit('initError', `E2EE unavailable: ${message}`);
    }
  }

  /**
   * Check whether a room has E2EE enabled (based on cached meta).
   */
  isRoomEncrypted(room: string): boolean {
    return this.roomMetaMap.get(room)?.enabled ?? false;
  }

  /**
   * Return cached room meta, or null if not yet fetched.
   */
  getRoomMeta(room: string): E2EERoomMeta | null {
    const internal = this.roomMetaMap.get(room);
    if (!internal) return null;
    return {
      enabled: internal.enabled,
      epoch: internal.currentEpoch,
      enabledBy: internal.initiator,
    };
  }

  /**
   * Fetch room meta from e2ee-key-service, cache it, and return it.
   * Returns cached value if available and no previous fetch error occurred.
   * On error returns null without caching (so next call retries).
   */
  async fetchRoomMeta(room: string): Promise<E2EERoomMeta | null> {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) return null;

    // Return cached if available and no error
    const cached = this.roomMetaMap.get(room);
    if (cached !== undefined && !this.metaFetchErrors.has(room)) {
      return { enabled: cached.enabled, epoch: cached.currentEpoch, enabledBy: cached.initiator };
    }

    try {
      const reply = await nc.request(`e2ee.room.meta.${room}`, sc.encode(''), { timeout: 3000 });
      const raw = JSON.parse(sc.decode(reply.data));

      const meta: InternalRoomMeta = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
        currentEpoch: typeof raw.currentEpoch === 'number' ? raw.currentEpoch : 0,
        initiator: typeof raw.initiator === 'string' ? raw.initiator : undefined,
      };

      this.metaFetchErrors.delete(room);
      this.roomMetaMap.set(room, meta);

      // If E2EE is enabled, fetch our room keys
      if (meta.enabled) {
        await this._fetchAndStoreRoomKey(room);
      }

      return { enabled: meta.enabled, epoch: meta.currentEpoch, enabledBy: meta.initiator };
    } catch (err) {
      console.warn(`[E2EEKeyManager] Failed to fetch room meta for ${room}, will retry on next access:`, err);
      // Do NOT cache on error — leave uncached so next access retries
      this.metaFetchErrors.add(room);
      return null;
    }
  }

  /**
   * Enable E2EE on a room. Generates a new room key, fetches all members,
   * wraps the key for each member, publishes the raw key for server-side
   * decryption, then enables E2EE on the room via e2ee-key-service.
   */
  async enableRoom(room: string): Promise<EnableE2EEResult> {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected || !this.identityKey) {
      return { ok: false, failedMembers: [] };
    }

    const failedMembers: string[] = [];

    try {
      // 1. Generate room key
      const roomKey = await generateRoomKey();
      const epoch = 1;

      // 2. Publish raw key for server-side decryption FIRST so persist-worker
      //    can decrypt messages as soon as they arrive (prevents the race where
      //    encrypted messages reach persist-worker before the raw key is stored).
      const rawKeyB64 = await exportRoomKeyRaw(roomKey);
      try {
        const rawReply = await nc.request(`e2ee.roomkey.raw.pub.${this.username}`, sc.encode(JSON.stringify({
          room,
          epoch,
          rawKey: rawKeyB64,
        })), { timeout: 5000 });
        const rawResult = JSON.parse(sc.decode(rawReply.data));
        if (rawResult.error) {
          console.error(`[E2EEKeyManager] Raw key publish rejected: ${rawResult.error}`);
          return { ok: false, failedMembers };
        }
      } catch (rawErr) {
        console.error('[E2EEKeyManager] Raw key publish failed — aborting E2EE enable:', rawErr);
        return { ok: false, failedMembers };
      }

      // 3. Fetch room members
      const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 5000 });
      const members = JSON.parse(sc.decode(membersReply.data)) as string[];

      // 4. Wrap key for each member
      let successCount = 0;
      for (const member of members) {
        try {
          const keyReply = await nc.request(`e2ee.keys.get.${member}`, sc.encode(''), { timeout: 3000 });
          const keyData = JSON.parse(sc.decode(keyReply.data));
          if (keyData.error) {
            console.warn(`[E2EEKeyManager] No identity key for ${member}, skipping`);
            failedMembers.push(member);
            continue;
          }

          const memberPublicKey = await importPublicKey(keyData.publicKey);
          const wrapped = await wrapRoomKeyForRecipient(
            roomKey,
            this.identityKey!.privateKey,
            memberPublicKey,
            room,
            epoch,
          );

          nc.publish(`e2ee.roomkey.distribute.${this.username}`, sc.encode(JSON.stringify({
            room,
            epoch,
            recipient: member,
            wrappedKey: wrapped,
            sender: this.username,
          })));
          successCount++;
        } catch (err) {
          console.warn(`[E2EEKeyManager] Failed to distribute key to ${member}:`, err);
          failedMembers.push(member);
        }
      }

      // Fail if no members received the key
      if (successCount === 0 && members.length > 0) {
        console.error('[E2EEKeyManager] Failed to distribute key to any member');
        return { ok: false, failedMembers };
      }

      // 5. Enable E2EE on the room
      const enableReply = await nc.request(`e2ee.room.enable.${room}`, sc.encode(JSON.stringify({
        room,
        currentEpoch: epoch,
        initiator: this.username,
      })), { timeout: 5000 });

      const result = JSON.parse(sc.decode(enableReply.data));
      if (!result.ok) return { ok: false, failedMembers };

      // 6. Store our own key locally
      await storeRoomKey(room, epoch, roomKey);

      // 7. Update local meta cache
      this.roomMetaMap.set(room, { enabled: true, currentEpoch: epoch, initiator: this.username });

      // 8. Post system message
      const systemMsg = {
        user: '__system__',
        text: `End-to-end encryption enabled by ${this.username}`,
        timestamp: Date.now(),
        room,
        action: 'system' as const,
      };
      nc.publish(`deliver.${this.username}.send.${room}`, sc.encode(JSON.stringify(systemMsg)));

      console.log(`[E2EEKeyManager] Enabled E2EE for room ${room}`);
      if (failedMembers.length > 0) {
        console.warn(`[E2EEKeyManager] Failed to distribute key to members: ${failedMembers.join(', ')}`);
      }

      this.emit('roomEnabled', room);
      return { ok: true, failedMembers };
    } catch (err) {
      console.error('[E2EEKeyManager] Failed to enable E2EE:', err);
      return { ok: false, failedMembers };
    }
  }

  /**
   * Encrypt plaintext for an E2EE room. Returns { ciphertext, epoch } or null
   * if E2EE is not enabled or no room key is available.
   */
  async encrypt(
    room: string,
    plaintext: string,
    user: string,
    timestamp: number,
  ): Promise<{ ciphertext: string; epoch: number } | null> {
    const meta = this.roomMetaMap.get(room);
    if (!meta?.enabled) return null;

    const epoch = meta.currentEpoch;
    const roomKey = await getRoomKey(room, epoch);
    if (!roomKey) {
      console.warn(`[E2EEKeyManager] No room key for ${room} epoch ${epoch}`);
      return null;
    }

    const ciphertext = await encryptText(room, user, timestamp, epoch, plaintext, roomKey);
    return { ciphertext, epoch };
  }

  /**
   * Decrypt an encrypted chat message. Returns a DecryptResult union.
   */
  async decrypt(msg: ChatMessage): Promise<DecryptResult> {
    // Determine the epoch from either e2ee field or e2eeEpoch (history)
    const epoch = (msg as any).e2ee?.epoch ?? (msg as any).e2eeEpoch;
    if (epoch === undefined) return { status: 'plaintext', text: msg.text };

    const roomKey = await getRoomKey(msg.room, epoch);
    if (!roomKey) {
      // Try to fetch from key service
      const fetched = await this._fetchAndStoreRoomKey(msg.room);
      if (fetched) {
        const retryKey = await getRoomKey(msg.room, epoch);
        if (retryKey) {
          try {
            const text = await decryptText(msg.room, msg.user, msg.timestamp, epoch, msg.text, retryKey);
            return { status: 'decrypted', text };
          } catch (err) {
            console.warn('[E2EEKeyManager] Decryption failed after key fetch:', err);
            return { status: 'failed', text: msg.text, error: 'Decryption failed — message may be corrupted' };
          }
        }
      }
      return { status: 'no_key', text: msg.text };
    }

    try {
      const text = await decryptText(msg.room, msg.user, msg.timestamp, epoch, msg.text, roomKey);
      return { status: 'decrypted', text };
    } catch (err) {
      console.warn('[E2EEKeyManager] Decryption failed:', err);
      return { status: 'failed', text: msg.text, error: 'Decryption failed — message may be corrupted' };
    }
  }

  /**
   * Stop all subscriptions and clean up.
   */
  destroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
    this.subscriptions = [];
    this._ready = false;
    this.identityKey = null;
    this.roomMetaMap.clear();
    this.metaFetchErrors.clear();
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
    this.removeAllListeners();
  }

  // --- Private helpers ---

  /**
   * Listen for room key updates from other tabs via BroadcastChannel.
   * When another tab stores a new room key (e.g., from a key rotation),
   * this tab refreshes its room meta so it can encrypt with the new epoch.
   */
  private _startBroadcastChannelListener(): void {
    try {
      this.broadcastChannel = new BroadcastChannel('e2ee-key-updates');
      this.broadcastChannel.onmessage = async (event) => {
        const { type, room, epoch } = event.data ?? {};
        if (type !== 'room-key' || !room) return;

        // Update local meta if the notified epoch is newer
        const meta = this.roomMetaMap.get(room);
        if (meta && meta.enabled && epoch > meta.currentEpoch) {
          this.roomMetaMap.set(room, { ...meta, currentEpoch: epoch });
          this.emit('keyRotated', room, epoch);
        }
      };
    } catch {
      // BroadcastChannel not available (e.g., in test environments)
    }
  }

  /**
   * Fetch and store wrapped room keys from e2ee-key-service, with a fallback
   * to requesting from an online member if no wrapped keys are found in KV.
   */
  private async _fetchAndStoreRoomKey(room: string): Promise<boolean> {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected || !this.identityKey) return false;

    try {
      const reply = await nc.request(
        `e2ee.roomkey.get.${room}.${this.username}`,
        sc.encode(''),
        { timeout: 5000 },
      );
      const data = JSON.parse(sc.decode(reply.data));

      if (data.error) {
        console.warn(`[E2EEKeyManager] Key service error for ${room}: ${data.error}`);
        return false;
      }

      const wrappedKeys = data.wrappedKeys as Array<{ wrappedKey: string; sender: string; epoch: number }>;

      for (const wk of wrappedKeys) {
        try {
          // Check if we already have this key
          const existing = await getRoomKey(room, wk.epoch);
          if (existing) continue;

          // Fetch sender's public key
          const senderReply = await nc.request(`e2ee.keys.get.${wk.sender}`, sc.encode(''), { timeout: 5000 });
          const senderData = JSON.parse(sc.decode(senderReply.data));
          if (senderData.error) continue;

          const senderPublicKey = await importPublicKey(senderData.publicKey);
          const roomKey = await unwrapRoomKey(
            wk.wrappedKey,
            this.identityKey!.privateKey,
            senderPublicKey,
            room,
            wk.epoch,
          );

          await storeRoomKey(room, wk.epoch, roomKey);
          console.log(`[E2EEKeyManager] Stored room key for ${room} epoch ${wk.epoch}`);
        } catch (unwrapErr) {
          console.warn(`[E2EEKeyManager] Failed to unwrap key for ${room} epoch ${wk.epoch}:`, unwrapErr);
        }
      }

      if (wrappedKeys.length > 0) return true;

      // No wrapped keys found in KV — request from an online member
      try {
        const requestReply = await nc.request(
          `e2ee.roomkey.request.${room}`,
          sc.encode(JSON.stringify({
            username: this.username,
            publicKey: this.identityKey!.publicKeyJwk,
          })),
          { timeout: 5000 },
        );
        const response = JSON.parse(sc.decode(requestReply.data)) as {
          wrappedKey: string; epoch: number; sender: string; senderPublicKey: JsonWebKey;
        };
        const senderPub = await importPublicKey(response.senderPublicKey);
        const roomKey = await unwrapRoomKey(
          response.wrappedKey,
          this.identityKey!.privateKey,
          senderPub,
          room,
          response.epoch,
        );
        await storeRoomKey(room, response.epoch, roomKey);
        console.log(`[E2EEKeyManager] Got room key via request for ${room} epoch ${response.epoch}`);
        return true;
      } catch (reqErr) {
        console.warn(`[E2EEKeyManager] Key request fallback failed for ${room}:`, reqErr);
      }

      return false;
    } catch (err) {
      console.warn(`[E2EEKeyManager] Failed to fetch room key for ${room}:`, err);
      return false;
    }
  }

  /**
   * Start NATS subscriptions for:
   *   - Key rotation notifications (e2ee.roomkey.rotate.*)
   *   - Key distribution requests from new members (e2ee.roomkey.request.*)
   *   - Membership changes to trigger key rotation on member leave (room.changed.*)
   */
  private _startSubscriptions(): void {
    const nc = this.cm.nc;
    if (!nc) return;

    // --- Key rotation notifications ---
    const rotationSub = nc.subscribe('e2ee.roomkey.rotate.*');
    this.subscriptions.push(rotationSub);

    (async () => {
      for await (const msg of rotationSub) {
        try {
          const parts = msg.subject.split('.');
          const room = parts[3];
          const data = JSON.parse(sc.decode(msg.data));
          const newEpoch = data.newEpoch as number;

          console.log(`[E2EEKeyManager] Key rotation for room ${room}, new epoch: ${newEpoch}`);

          // Update local meta
          const existing = this.roomMetaMap.get(room);
          if (existing) {
            this.roomMetaMap.set(room, { ...existing, currentEpoch: newEpoch });
          }

          // Fetch our new wrapped key
          await this._fetchAndStoreRoomKey(room);

          this.emit('keyRotated', room, newEpoch);
        } catch (err) {
          console.warn('[E2EEKeyManager] Error processing key rotation:', err);
        }
      }
    })();

    // --- Key distribution requests from new members ---
    const requestSub = nc.subscribe('e2ee.roomkey.request.*');
    this.subscriptions.push(requestSub);

    (async () => {
      for await (const msg of requestSub) {
        try {
          const parts = msg.subject.split('.');
          const room = parts[3];
          const meta = this.roomMetaMap.get(room);
          if (!meta?.enabled || !this.identityKey) continue;

          const data = JSON.parse(sc.decode(msg.data));
          const requesterUsername = data.username as string;
          const requesterPublicKeyJwk = data.publicKey as JsonWebKey;

          // Verify the requester is a room member before distributing keys
          try {
            const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 3000 });
            const members = JSON.parse(sc.decode(membersReply.data)) as string[];
            if (!members.includes(requesterUsername)) {
              console.warn(`[E2EEKeyManager] Key request rejected: ${requesterUsername} is not a member of ${room}`);
              continue;
            }
          } catch (memberErr) {
            console.warn(`[E2EEKeyManager] Could not verify membership for ${requesterUsername} in ${room}:`, memberErr);
            continue;
          }

          const currentKey = await getRoomKey(room, meta.currentEpoch);
          if (!currentKey) continue;

          const requesterPublicKey = await importPublicKey(requesterPublicKeyJwk);
          const wrapped = await wrapRoomKeyForRecipient(
            currentKey,
            this.identityKey!.privateKey,
            requesterPublicKey,
            room,
            meta.currentEpoch,
          );

          // Store in key service
          nc.publish(`e2ee.roomkey.distribute.${this.username}`, sc.encode(JSON.stringify({
            room,
            epoch: meta.currentEpoch,
            recipient: requesterUsername,
            wrappedKey: wrapped,
            sender: this.username,
          })));

          // Respond directly to requester
          if (msg.reply) {
            msg.respond(sc.encode(JSON.stringify({
              wrappedKey: wrapped,
              epoch: meta.currentEpoch,
              sender: this.username,
              senderPublicKey: this.identityKey!.publicKeyJwk,
            })));
          }

          console.log(`[E2EEKeyManager] Distributed key to ${requesterUsername} for room ${room}`);
        } catch (err) {
          console.warn('[E2EEKeyManager] Error handling key request:', err);
        }
      }
    })();

    // --- Membership changes: trigger key rotation on member leave ---
    // All online members receiving a leave/kick event attempt key rotation simultaneously.
    // The server enforces monotonic epochs via CAS (compare-and-swap), so only the first
    // writer's key is accepted. Losing clients detect the conflict and fetch the winning key.
    const memberChangeSub = nc.subscribe('room.changed.*');
    this.subscriptions.push(memberChangeSub);

    (async () => {
      for await (const msg of memberChangeSub) {
        try {
          const parts = msg.subject.split('.');
          const room = parts[2];
          const meta = this.roomMetaMap.get(room);
          if (!meta?.enabled || !this.identityKey) continue;

          const data = JSON.parse(sc.decode(msg.data));
          // Only rotate on member removal (leave/kick)
          if (data.action !== 'leave' && data.action !== 'kick') continue;

          console.log(`[E2EEKeyManager] Member ${data.userId} left ${room}, rotating key`);

          // Generate new room key
          const newRoomKey = await generateRoomKey();
          const newEpoch = meta.currentEpoch + 1;

          // Update epoch on server FIRST — CAS ensures only one client succeeds.
          try {
            const epochReply = await nc.request(
              `e2ee.room.epoch.${room}`,
              sc.encode(JSON.stringify({ newEpoch, caller: this.username })),
              { timeout: 5000 },
            );
            const epochResult = JSON.parse(sc.decode(epochReply.data));
            if (epochResult.error) {
              // CAS conflict: another client won the race. Fetch their key instead.
              console.log(`[E2EEKeyManager] Key rotation CAS conflict for ${room}: ${epochResult.error}. Fetching winning key.`);
              await this._fetchAndStoreRoomKey(room);
              const metaReply = await nc.request(`e2ee.room.meta.${room}`, sc.encode(''), { timeout: 3000 });
              const updatedMeta = JSON.parse(sc.decode(metaReply.data)) as InternalRoomMeta;
              this.roomMetaMap.set(room, updatedMeta);
              continue;
            }
          } catch (epochErr) {
            console.warn(`[E2EEKeyManager] Failed to update epoch for ${room}, rotation may be incomplete:`, epochErr);
            continue;
          }

          // CAS succeeded — we are the rotation coordinator.
          // Store our own key immediately so we can encrypt with the new epoch right away.
          await storeRoomKey(room, newEpoch, newRoomKey);
          this.roomMetaMap.set(room, { ...meta, currentEpoch: newEpoch });

          // Publish raw key for server-side decryption FIRST (same rationale as enableRoom:
          // persist-worker needs the key before encrypted messages arrive).
          const rawKeyB64 = await exportRoomKeyRaw(newRoomKey);
          try {
            const rawReply = await nc.request(
              `e2ee.roomkey.raw.pub.${this.username}`,
              sc.encode(JSON.stringify({ room, epoch: newEpoch, rawKey: rawKeyB64 })),
              { timeout: 5000 },
            );
            const rawResult = JSON.parse(sc.decode(rawReply.data));
            if (rawResult.error) {
              console.warn(`[E2EEKeyManager] Raw key publish rejected during rotation: ${rawResult.error}`);
            }
          } catch (rawErr) {
            console.warn(`[E2EEKeyManager] Raw key publish failed during rotation for ${room}:`, rawErr);
          }

          // Fetch remaining members and distribute wrapped keys.
          const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 5000 });
          const members = JSON.parse(sc.decode(membersReply.data)) as string[];

          for (const member of members) {
            try {
              const keyReply = await nc.request(`e2ee.keys.get.${member}`, sc.encode(''), { timeout: 3000 });
              const keyData = JSON.parse(sc.decode(keyReply.data));
              if (keyData.error) continue;
              const memberPub = await importPublicKey(keyData.publicKey);
              const wrapped = await wrapRoomKeyForRecipient(
                newRoomKey,
                this.identityKey!.privateKey,
                memberPub,
                room,
                newEpoch,
              );
              nc.publish(`e2ee.roomkey.distribute.${this.username}`, sc.encode(JSON.stringify({
                room, epoch: newEpoch, recipient: member, wrappedKey: wrapped, sender: this.username,
              })));
            } catch (err) {
              console.warn(`[E2EEKeyManager] Failed to distribute rotated key to ${member}:`, err);
            }
          }

          // Notify other clients
          nc.publish(`e2ee.roomkey.rotate.${room}`, sc.encode(JSON.stringify({ newEpoch })));
          console.log(`[E2EEKeyManager] Key rotated for ${room} to epoch ${newEpoch}`);

          this.emit('keyRotated', room, newEpoch);
        } catch (err) {
          console.warn('[E2EEKeyManager] Error handling member change for key rotation:', err);
        }
      }
    })();
  }
}
