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

interface E2EEContextType {
  /** Whether E2EE is enabled for a specific room */
  isE2EE: (room: string) => boolean;
  /** Get E2EE metadata for a room */
  getE2EEMeta: (room: string) => RoomE2EEMeta | null;
  /** Encrypt message text for an E2EE room. Returns { ciphertext, epoch } */
  encrypt: (room: string, user: string, timestamp: number, text: string) => Promise<{ ciphertext: string; epoch: number } | null>;
  /** Decrypt message text. Returns plaintext or null on failure */
  decrypt: (msg: ChatMessage) => Promise<string | null>;
  /** Enable E2EE on a room (generates key, distributes to members) */
  enableE2EE: (room: string) => Promise<boolean>;
  /** Whether the identity key has been initialized */
  ready: boolean;
  /** Fetch and cache E2EE meta for a room */
  fetchRoomMeta: (room: string) => Promise<RoomE2EEMeta | null>;
}

const E2EEContext = createContext<E2EEContextType>({
  isE2EE: () => false,
  getE2EEMeta: () => null,
  encrypt: async () => null,
  decrypt: async () => null,
  enableE2EE: async () => false,
  ready: false,
  fetchRoomMeta: async () => null,
});

export const useE2EE = () => useContext(E2EEContext);

export const E2EEProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { nc, connected, sc } = useNats();
  const { userInfo } = useAuth();
  const [ready, setReady] = useState(false);
  const identityKeyRef = useRef<{ privateKey: CryptoKey; publicKey: CryptoKey; publicKeyJwk: JsonWebKey } | null>(null);
  const roomMetaRef = useRef<Record<string, RoomE2EEMeta>>({});
  const [, forceUpdate] = useState(0);

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
        nc.publish('e2ee.identity.publish', sc.encode(payload));
        console.log('[E2EE] Identity key initialized and published');

        setReady(true);
      } catch (err) {
        console.error('[E2EE] Failed to initialize identity key:', err);
      }
    })();
  }, [nc, connected, userInfo, sc]);

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
          if (roomMetaRef.current[room]) {
            roomMetaRef.current[room].currentEpoch = newEpoch;
          }

          // Fetch our new wrapped key
          await fetchAndStoreRoomKey(room, userInfo.username);
          forceUpdate((n) => n + 1);
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

          // Check if we should be the coordinator (alphabetically first)
          // For simplicity, always respond — duplicate responses are harmless
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

    return () => {
      subs.forEach((s) => s.unsubscribe());
    };
  }, [nc, connected, userInfo, sc, ready]);

  const fetchAndStoreRoomKey = useCallback(async (room: string, username: string) => {
    if (!nc || !connected || !identityKeyRef.current) return false;

    try {
      const reply = await nc.request(`e2ee.roomkey.get.${room}.${username}`, sc.encode(''), { timeout: 5000 });
      const data = JSON.parse(sc.decode(reply.data));
      const wrappedKeys = data.wrappedKeys as Array<{ wrappedKey: string; sender: string; epoch: number }>;

      for (const wk of wrappedKeys) {
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
      }

      return wrappedKeys.length > 0;
    } catch (err) {
      console.warn(`[E2EE] Failed to fetch room key for ${room}:`, err);
      return false;
    }
  }, [nc, connected, sc]);

  const fetchRoomMeta = useCallback(async (room: string): Promise<RoomE2EEMeta | null> => {
    if (!nc || !connected) return null;

    // Return cached if available
    if (roomMetaRef.current[room] !== undefined) {
      return roomMetaRef.current[room];
    }

    try {
      const reply = await nc.request(`e2ee.room.meta.${room}`, sc.encode(''), { timeout: 3000 });
      const meta = JSON.parse(sc.decode(reply.data)) as RoomE2EEMeta;
      roomMetaRef.current[room] = meta;

      // If E2EE is enabled, fetch our room keys
      if (meta.enabled && userInfo) {
        await fetchAndStoreRoomKey(room, userInfo.username);
      }

      return meta;
    } catch {
      const defaultMeta: RoomE2EEMeta = { enabled: false, currentEpoch: 0 };
      roomMetaRef.current[room] = defaultMeta;
      return defaultMeta;
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

  const decrypt = useCallback(async (msg: ChatMessage): Promise<string | null> => {
    // Determine the epoch from either e2ee field or e2eeEpoch (history)
    const epoch = msg.e2ee?.epoch ?? msg.e2eeEpoch;
    if (epoch === undefined) return null;

    const roomKey = await getRoomKey(msg.room, epoch);
    if (!roomKey) {
      // Try to fetch from key service
      if (nc && connected && userInfo) {
        const fetched = await fetchAndStoreRoomKey(msg.room, userInfo.username);
        if (fetched) {
          const retryKey = await getRoomKey(msg.room, epoch);
          if (retryKey) {
            try {
              return await decryptText(msg.room, msg.user, msg.timestamp, epoch, msg.text, retryKey);
            } catch {
              return null;
            }
          }
        }
      }
      return null;
    }

    try {
      return await decryptText(msg.room, msg.user, msg.timestamp, epoch, msg.text, roomKey);
    } catch (err) {
      console.warn('[E2EE] Decryption failed:', err);
      return null;
    }
  }, [nc, connected, userInfo, fetchAndStoreRoomKey]);

  const enableE2EE = useCallback(async (room: string): Promise<boolean> => {
    if (!nc || !connected || !userInfo || !identityKeyRef.current) return false;

    try {
      // 1. Generate room key
      const roomKey = await generateRoomKey();
      const epoch = 1;

      // 2. Fetch room members
      const membersReply = await nc.request(`room.members.${room}`, sc.encode(''), { timeout: 5000 });
      const members = JSON.parse(sc.decode(membersReply.data)) as string[];

      // 3. Wrap key for each member
      for (const member of members) {
        try {
          const keyReply = await nc.request(`e2ee.keys.get.${member}`, sc.encode(''), { timeout: 3000 });
          const keyData = JSON.parse(sc.decode(keyReply.data));
          if (keyData.error) {
            console.warn(`[E2EE] No identity key for ${member}, skipping`);
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
        } catch (err) {
          console.warn(`[E2EE] Failed to distribute key to ${member}:`, err);
        }
      }

      // 4. Publish raw key for server-side decryption (persist-worker)
      const rawKeyB64 = await exportRoomKeyRaw(roomKey);
      nc.publish('e2ee.roomkey.raw', sc.encode(JSON.stringify({
        room,
        epoch,
        rawKey: rawKeyB64,
      })));

      // 5. Enable E2EE on the room
      const enableReply = await nc.request(`e2ee.room.enable.${room}`, sc.encode(JSON.stringify({
        room,
        currentEpoch: epoch,
        initiator: userInfo.username,
      })), { timeout: 5000 });

      const result = JSON.parse(sc.decode(enableReply.data));
      if (!result.ok) return false;

      // 6. Store our own key locally
      await storeRoomKey(room, epoch, roomKey);

      // 7. Update local meta
      roomMetaRef.current[room] = { enabled: true, currentEpoch: epoch, initiator: userInfo.username };
      forceUpdate((n) => n + 1);

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
      return true;
    } catch (err) {
      console.error('[E2EE] Failed to enable E2EE:', err);
      return false;
    }
  }, [nc, connected, userInfo, sc]);

  return (
    <E2EEContext.Provider value={{ isE2EE, getE2EEMeta, encrypt, decrypt, enableE2EE, ready, fetchRoomMeta }}>
      {children}
    </E2EEContext.Provider>
  );
};
