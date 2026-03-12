import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useNats } from './NatsProvider';
import { useAuth } from './AuthProvider';
import type { ChatMessage } from '../types';
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
} from '../lib/E2EEManager';

interface RoomE2EEMeta {
  enabled: boolean;
  currentEpoch: number;
  initiator?: string;
}

export type DecryptResult =
  | { status: 'plaintext' }
  | { status: 'decrypted'; text: string }
  | { status: 'no_key'; epoch: number }
  | { status: 'failed'; error: string };

interface E2EEContextType {
  /** Whether E2EE is enabled for a specific room */
  isE2EE: (room: string) => boolean;
  /** Get E2EE metadata for a room */
  getE2EEMeta: (room: string) => RoomE2EEMeta | null;
  /** Encrypt message text for an E2EE room. Returns { ciphertext, epoch } */
  encrypt: (room: string, user: string, timestamp: number, text: string) => Promise<{ ciphertext: string; epoch: number } | null>;
  /** Decrypt message text. Returns structured result */
  decrypt: (msg: ChatMessage) => Promise<DecryptResult>;
  /** Enable E2EE on a room (generates key, distributes to members) */
  enableE2EE: (room: string) => Promise<{ ok: boolean; failedMembers: string[] }>;
  /** Whether the identity key has been initialized */
  ready: boolean;
  /** E2EE initialization error, if any */
  initError: string | null;
  /** Fetch and cache E2EE meta for a room */
  fetchRoomMeta: (room: string) => Promise<RoomE2EEMeta | null>;
}

const E2EEContext = createContext<E2EEContextType>({
  isE2EE: () => false,
  getE2EEMeta: () => null,
  encrypt: async () => null,
  decrypt: async () => ({ status: 'plaintext' }),
  enableE2EE: async () => ({ ok: false, failedMembers: [] }),
  ready: false,
  initError: null,
  fetchRoomMeta: async () => null,
});

export const useE2EE = () => useContext(E2EEContext);

export const E2EEProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { nc, connected, sc } = useNats();
  const { userInfo } = useAuth();
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const identityKeyRef = useRef<{ privateKey: CryptoKey; publicKey: CryptoKey; publicKeyJwk: JsonWebKey } | null>(null);
  const [roomMetaMap, setRoomMetaMap] = useState<Record<string, RoomE2EEMeta>>({});
  const roomMetaRef = useRef<Record<string, RoomE2EEMeta>>({});
  roomMetaRef.current = roomMetaMap;

  // Track which rooms had meta fetch errors so we can retry
  const metaFetchErrorsRef = useRef<Set<string>>(new Set());

  // Initialize identity key on mount
  useEffect(() => {
    if (!nc || !connected || !userInfo) return;

    (async () => {
      try {
        const identity = await getOrCreateIdentityKey(userInfo.username);
        identityKeyRef.current = identity;

        // Publish public key to e2ee-key-service
        const payload = JSON.stringify({
          username: userInfo.username,
          publicKey: identity.publicKeyJwk,
        });
        try {
          const pubReply = await nc.request('e2ee.identity.publish', sc.encode(payload), { timeout: 5000 });
          const pubResult = JSON.parse(sc.decode(pubReply.data));
          if (pubResult.error) {
            console.error('[E2EE] Identity key publish rejected:', pubResult.error);
            setInitError(`E2EE identity publish rejected: ${pubResult.error}`);
            return;
          }
          console.log('[E2EE] Identity key initialized and published');
        } catch (pubErr) {
          console.error('[E2EE] Identity key publish failed:', pubErr);
          setInitError('E2EE unavailable: identity key publish failed');
          return;
        }

        setInitError(null);
        setReady(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[E2EE] Failed to initialize identity key:', err);
        setInitError(`E2EE unavailable: ${message}`);
      }
    })();
  }, [nc, connected, userInfo, sc]);

  const fetchAndStoreRoomKey = useCallback(async (room: string, username: string) => {
    if (!nc || !connected || !identityKeyRef.current) return false;

    try {
      const reply = await nc.request(`e2ee.roomkey.get.${room}.${username}`, sc.encode(''), { timeout: 5000 });
      const data = JSON.parse(sc.decode(reply.data));

      if (data.error) {
        console.warn(`[E2EE] Key service error for ${room}: ${data.error}`);
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
            identityKeyRef.current!.privateKey,
            senderPublicKey,
            room,
            wk.epoch,
          );

          await storeRoomKey(room, wk.epoch, roomKey);
          console.log(`[E2EE] Stored room key for ${room} epoch ${wk.epoch}`);
        } catch (unwrapErr) {
          console.warn(`[E2EE] Failed to unwrap key for ${room} epoch ${wk.epoch}:`, unwrapErr);
        }
      }

      if (wrappedKeys.length > 0) return true;

      // No wrapped keys found in KV — request from an online member
      if (identityKeyRef.current) {
        try {
          const requestReply = await nc.request(`e2ee.roomkey.request.${room}`, sc.encode(JSON.stringify({
            username,
            publicKey: identityKeyRef.current.publicKeyJwk,
          })), { timeout: 5000 });
          const response = JSON.parse(sc.decode(requestReply.data)) as {
            wrappedKey: string; epoch: number; sender: string; senderPublicKey: JsonWebKey;
          };
          const senderPub = await importPublicKey(response.senderPublicKey);
          const roomKey = await unwrapRoomKey(
            response.wrappedKey,
            identityKeyRef.current.privateKey,
            senderPub,
            room,
            response.epoch,
          );
          await storeRoomKey(room, response.epoch, roomKey);
          console.log(`[E2EE] Got room key via request for ${room} epoch ${response.epoch}`);
          return true;
        } catch (reqErr) {
          console.warn(`[E2EE] Key request fallback failed for ${room}:`, reqErr);
        }
      }

      return false;
    } catch (err) {
      console.warn(`[E2EE] Failed to fetch room key for ${room}:`, err);
      return false;
    }
  }, [nc, connected, sc]);

  // Subscribe to key rotation notifications
  useEffect(() => {
    if (!nc || !connected || !userInfo || !ready) return;

    const subs: Array<{ unsubscribe: () => void }> = [];

    // Listen for key rotations on rooms we know about
    const rotationSub = nc.subscribe('e2ee.roomkey.rotate.*');
    subs.push(rotationSub);

    (async () => {
      for await (const msg of rotationSub) {
        try {
          const parts = msg.subject.split('.');
          const room = parts[3];
          const data = JSON.parse(sc.decode(msg.data));
          const newEpoch = data.newEpoch as number;

          console.log(`[E2EE] Key rotation for room ${room}, new epoch: ${newEpoch}`);

          // Update local meta
          setRoomMetaMap(prev => {
            if (!prev[room]) return prev;
            return { ...prev, [room]: { ...prev[room], currentEpoch: newEpoch } };
          });

          // Fetch our new wrapped key
          await fetchAndStoreRoomKey(room, userInfo.username);
        } catch (err) {
          console.warn('[E2EE] Error processing key rotation:', err);
        }
      }
    })();

    // Listen for key requests from new members (act as key distributor)
    const requestSub = nc.subscribe('e2ee.roomkey.request.*');
    subs.push(requestSub);

    (async () => {
      for await (const msg of requestSub) {
        try {
          const parts = msg.subject.split('.');
          const room = parts[3];
          const meta = roomMetaRef.current[room];
          if (!meta?.enabled || !identityKeyRef.current) continue;

          const data = JSON.parse(sc.decode(msg.data));
          const requesterUsername = data.username as string;
          const requesterPublicKeyJwk = data.publicKey as JsonWebKey;

          // Verify the requester is a room member before distributing keys
          try {
            const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 3000 });
            const members = JSON.parse(sc.decode(membersReply.data)) as string[];
            if (!members.includes(requesterUsername)) {
              console.warn(`[E2EE] Key request rejected: ${requesterUsername} is not a member of ${room}`);
              continue;
            }
          } catch (memberErr) {
            console.warn(`[E2EE] Could not verify membership for ${requesterUsername} in ${room}:`, memberErr);
            continue;
          }

          const currentKey = await getRoomKey(room, meta.currentEpoch);
          if (!currentKey) continue;

          const requesterPublicKey = await importPublicKey(requesterPublicKeyJwk);
          const wrapped = await wrapRoomKeyForRecipient(
            currentKey,
            identityKeyRef.current.privateKey,
            requesterPublicKey,
            room,
            meta.currentEpoch,
          );

          // Store in key service
          nc.publish('e2ee.roomkey.distribute', sc.encode(JSON.stringify({
            room,
            epoch: meta.currentEpoch,
            recipient: requesterUsername,
            wrappedKey: wrapped,
            sender: userInfo.username,
          })));

          // Respond directly to requester
          if (msg.reply) {
            msg.respond(sc.encode(JSON.stringify({
              wrappedKey: wrapped,
              epoch: meta.currentEpoch,
              sender: userInfo.username,
              senderPublicKey: identityKeyRef.current.publicKeyJwk,
            })));
          }

          console.log(`[E2EE] Distributed key to ${requesterUsername} for room ${room}`);
        } catch (err) {
          console.warn('[E2EE] Error handling key request:', err);
        }
      }
    })();

    // Listen for membership changes to trigger key rotation when a member leaves an E2EE room.
    // All online members receiving a leave/kick event attempt key rotation simultaneously.
    // The server enforces monotonic epochs via CAS (compare-and-swap), so only the first
    // writer's key is accepted. Losing clients detect the conflict and fetch the winning key.
    const memberChangeSub = nc.subscribe('room.changed.*');
    subs.push(memberChangeSub);

    (async () => {
      for await (const msg of memberChangeSub) {
        try {
          const parts = msg.subject.split('.');
          const room = parts[2];
          const meta = roomMetaRef.current[room];
          if (!meta?.enabled || !identityKeyRef.current) continue;

          const data = JSON.parse(sc.decode(msg.data));
          // Only rotate on member removal (leave/kick)
          if (data.action !== 'leave' && data.action !== 'kick') continue;

          console.log(`[E2EE] Member ${data.userId} left ${room}, rotating key`);

          // Generate new room key
          const newRoomKey = await generateRoomKey();
          const newEpoch = meta.currentEpoch + 1;

          // Update epoch on server FIRST — CAS ensures only one client succeeds.
          // Only the CAS winner distributes keys and publishes raw key.
          try {
            const epochReply = await nc.request(`e2ee.room.epoch.${room}`, sc.encode(JSON.stringify({ newEpoch })), { timeout: 5000 });
            const epochResult = JSON.parse(sc.decode(epochReply.data));
            if (epochResult.error) {
              // CAS conflict: another client won the race. Fetch their key instead.
              console.log(`[E2EE] Key rotation CAS conflict for ${room}: ${epochResult.error}. Fetching winning key.`);
              await fetchAndStoreRoomKey(room, userInfo.username);
              const metaReply = await nc.request(`e2ee.room.meta.${room}`, sc.encode(''), { timeout: 3000 });
              const updatedMeta = JSON.parse(sc.decode(metaReply.data)) as RoomE2EEMeta;
              setRoomMetaMap(prev => ({ ...prev, [room]: updatedMeta }));
              continue;
            }
          } catch (epochErr) {
            console.warn(`[E2EE] Failed to update epoch for ${room}, rotation may be incomplete:`, epochErr);
            continue;
          }

          // CAS succeeded — we are the rotation coordinator.
          // Fetch remaining members and distribute wrapped keys.
          const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 5000 });
          const members = JSON.parse(sc.decode(membersReply.data)) as string[];

          for (const member of members) {
            try {
              const keyReply = await nc.request(`e2ee.keys.get.${member}`, sc.encode(''), { timeout: 3000 });
              const keyData = JSON.parse(sc.decode(keyReply.data));
              if (keyData.error) continue;
              const memberPub = await importPublicKey(keyData.publicKey);
              const wrapped = await wrapRoomKeyForRecipient(newRoomKey, identityKeyRef.current!.privateKey, memberPub, room, newEpoch);
              nc.publish('e2ee.roomkey.distribute', sc.encode(JSON.stringify({
                room, epoch: newEpoch, recipient: member, wrappedKey: wrapped, sender: userInfo.username,
              })));
            } catch (err) {
              console.warn(`[E2EE] Failed to distribute rotated key to ${member}:`, err);
            }
          }

          // Publish raw key for server-side decryption (after CAS success)
          const rawKeyB64 = await exportRoomKeyRaw(newRoomKey);
          try {
            const rawReply = await nc.request('e2ee.roomkey.raw', sc.encode(JSON.stringify({ room, epoch: newEpoch, rawKey: rawKeyB64 })), { timeout: 5000 });
            const rawResult = JSON.parse(sc.decode(rawReply.data));
            if (rawResult.error) {
              console.warn(`[E2EE] Raw key publish rejected during rotation: ${rawResult.error}`);
            }
          } catch (rawErr) {
            console.warn(`[E2EE] Raw key publish failed during rotation for ${room}:`, rawErr);
          }

          // Store locally and update meta
          await storeRoomKey(room, newEpoch, newRoomKey);
          setRoomMetaMap(prev => ({ ...prev, [room]: { ...prev[room], currentEpoch: newEpoch } }));

          // Notify other clients
          nc.publish(`e2ee.roomkey.rotate.${room}`, sc.encode(JSON.stringify({ newEpoch })));
          console.log(`[E2EE] Key rotated for ${room} to epoch ${newEpoch}`);
        } catch (err) {
          console.warn('[E2EE] Error handling member change for key rotation:', err);
        }
      }
    })();

    return () => {
      subs.forEach((s) => s.unsubscribe());
    };
  }, [nc, connected, userInfo, sc, ready, fetchAndStoreRoomKey]);

  const fetchRoomMeta = useCallback(async (room: string): Promise<RoomE2EEMeta | null> => {
    if (!nc || !connected) return null;

    // Return cached if available (unless it was cached from an error)
    if (roomMetaRef.current[room] !== undefined && !metaFetchErrorsRef.current.has(room)) {
      return roomMetaRef.current[room];
    }

    try {
      const reply = await nc.request(`e2ee.room.meta.${room}`, sc.encode(''), { timeout: 3000 });
      const raw = JSON.parse(sc.decode(reply.data));

      // Runtime validation of the response
      const meta: RoomE2EEMeta = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
        currentEpoch: typeof raw.currentEpoch === 'number' ? raw.currentEpoch : 0,
        initiator: typeof raw.initiator === 'string' ? raw.initiator : undefined,
      };

      metaFetchErrorsRef.current.delete(room);
      setRoomMetaMap(prev => ({ ...prev, [room]: meta }));

      // If E2EE is enabled, fetch our room keys
      if (meta.enabled && userInfo) {
        await fetchAndStoreRoomKey(room, userInfo.username);
      }

      return meta;
    } catch (err) {
      console.warn(`[E2EE] Failed to fetch room meta for ${room}, will retry on next access:`, err);
      // Do NOT cache enabled:false on error — leave uncached so next access retries
      metaFetchErrorsRef.current.add(room);
      return null;
    }
  }, [nc, connected, sc, userInfo, fetchAndStoreRoomKey]);

  const isE2EE = useCallback((room: string): boolean => {
    return roomMetaRef.current[room]?.enabled ?? false;
  }, []);

  const getE2EEMeta = useCallback((room: string): RoomE2EEMeta | null => {
    return roomMetaRef.current[room] ?? null;
  }, []);

  const encrypt = useCallback(async (
    room: string,
    user: string,
    timestamp: number,
    text: string,
  ): Promise<{ ciphertext: string; epoch: number } | null> => {
    const meta = roomMetaRef.current[room];
    if (!meta?.enabled) return null;

    const epoch = meta.currentEpoch;
    const roomKey = await getRoomKey(room, epoch);
    if (!roomKey) {
      console.warn(`[E2EE] No room key for ${room} epoch ${epoch}`);
      return null;
    }

    const ciphertext = await encryptText(room, user, timestamp, epoch, text, roomKey);
    return { ciphertext, epoch };
  }, []);

  const decrypt = useCallback(async (msg: ChatMessage): Promise<DecryptResult> => {
    // Determine the epoch from either e2ee field or e2eeEpoch (history)
    const epoch = msg.e2ee?.epoch ?? msg.e2eeEpoch;
    if (epoch === undefined) return { status: 'plaintext' };

    const roomKey = await getRoomKey(msg.room, epoch);
    if (!roomKey) {
      // Try to fetch from key service
      if (nc && connected && userInfo) {
        const fetched = await fetchAndStoreRoomKey(msg.room, userInfo.username);
        if (fetched) {
          const retryKey = await getRoomKey(msg.room, epoch);
          if (retryKey) {
            try {
              const text = await decryptText(msg.room, msg.user, msg.timestamp, epoch, msg.text, retryKey);
              return { status: 'decrypted', text };
            } catch (err) {
              console.warn('[E2EE] Decryption failed after key fetch:', err);
              return { status: 'failed', error: 'Decryption failed — message may be corrupted' };
            }
          }
        }
      }
      return { status: 'no_key', epoch };
    }

    try {
      const text = await decryptText(msg.room, msg.user, msg.timestamp, epoch, msg.text, roomKey);
      return { status: 'decrypted', text };
    } catch (err) {
      console.warn('[E2EE] Decryption failed:', err);
      return { status: 'failed', error: 'Decryption failed — message may be corrupted' };
    }
  }, [nc, connected, userInfo, fetchAndStoreRoomKey]);

  const enableE2EE = useCallback(async (room: string): Promise<{ ok: boolean; failedMembers: string[] }> => {
    if (!nc || !connected || !userInfo || !identityKeyRef.current) return { ok: false, failedMembers: [] };

    const failedMembers: string[] = [];

    try {
      // 1. Generate room key
      const roomKey = await generateRoomKey();
      const epoch = 1;

      // 2. Fetch room members
      const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 5000 });
      const members = JSON.parse(sc.decode(membersReply.data)) as string[];

      // 3. Wrap key for each member
      let successCount = 0;
      for (const member of members) {
        try {
          const keyReply = await nc.request(`e2ee.keys.get.${member}`, sc.encode(''), { timeout: 3000 });
          const keyData = JSON.parse(sc.decode(keyReply.data));
          if (keyData.error) {
            console.warn(`[E2EE] No identity key for ${member}, skipping`);
            failedMembers.push(member);
            continue;
          }

          const memberPublicKey = await importPublicKey(keyData.publicKey);
          const wrapped = await wrapRoomKeyForRecipient(
            roomKey,
            identityKeyRef.current!.privateKey,
            memberPublicKey,
            room,
            epoch,
          );

          nc.publish('e2ee.roomkey.distribute', sc.encode(JSON.stringify({
            room,
            epoch,
            recipient: member,
            wrappedKey: wrapped,
            sender: userInfo.username,
          })));
          successCount++;
        } catch (err) {
          console.warn(`[E2EE] Failed to distribute key to ${member}:`, err);
          failedMembers.push(member);
        }
      }

      // Fail if no members received the key (other than ourselves)
      if (successCount === 0 && members.length > 0) {
        console.error('[E2EE] Failed to distribute key to any member');
        return { ok: false, failedMembers };
      }

      // 4. Publish raw key for server-side decryption (persist-worker)
      // This MUST succeed — without the raw key, persist-worker cannot decrypt and store messages.
      const rawKeyB64 = await exportRoomKeyRaw(roomKey);
      try {
        const rawReply = await nc.request('e2ee.roomkey.raw', sc.encode(JSON.stringify({
          room,
          epoch,
          rawKey: rawKeyB64,
        })), { timeout: 5000 });
        const rawResult = JSON.parse(sc.decode(rawReply.data));
        if (rawResult.error) {
          console.error(`[E2EE] Raw key publish rejected: ${rawResult.error}`);
          return { ok: false, failedMembers };
        }
      } catch (rawErr) {
        console.error('[E2EE] Raw key publish failed — aborting E2EE enable:', rawErr);
        return { ok: false, failedMembers };
      }

      // 5. Enable E2EE on the room
      const enableReply = await nc.request(`e2ee.room.enable.${room}`, sc.encode(JSON.stringify({
        room,
        currentEpoch: epoch,
        initiator: userInfo.username,
      })), { timeout: 5000 });

      const result = JSON.parse(sc.decode(enableReply.data));
      if (!result.ok) return { ok: false, failedMembers };

      // 6. Store our own key locally
      await storeRoomKey(room, epoch, roomKey);

      // 7. Update local meta
      setRoomMetaMap(prev => ({ ...prev, [room]: { enabled: true, currentEpoch: epoch, initiator: userInfo.username } }));

      // 8. Post system message
      const systemMsg = {
        user: '__system__',
        text: `End-to-end encryption enabled by ${userInfo.username}`,
        timestamp: Date.now(),
        room,
        action: 'system' as const,
      };
      nc.publish(`deliver.${userInfo.username}.send.${room}`, sc.encode(JSON.stringify(systemMsg)));

      console.log(`[E2EE] Enabled E2EE for room ${room}`);
      if (failedMembers.length > 0) {
        console.warn(`[E2EE] Failed to distribute key to members: ${failedMembers.join(', ')}`);
      }
      return { ok: true, failedMembers };
    } catch (err) {
      console.error('[E2EE] Failed to enable E2EE:', err);
      return { ok: false, failedMembers };
    }
  }, [nc, connected, userInfo, sc]);

  return (
    <E2EEContext.Provider value={{ isE2EE, getE2EEMeta, encrypt, decrypt, enableE2EE, ready, initError, fetchRoomMeta }}>
      {children}
    </E2EEContext.Provider>
  );
};
