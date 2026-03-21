import { useState, useEffect, useCallback } from 'react';
import type { ChatClient } from '../lib/chat-client';

export function useE2EE(client: ChatClient | null) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyChangeWarning, setKeyChangeWarning] = useState<{
    username: string; oldFingerprint: string; newFingerprint: string;
  } | null>(null);

  useEffect(() => {
    if (!client) return;
    setReady(client.e2ee.isReady);

    const unsubs = [
      client.e2ee.on('ready', () => { setReady(true); setError(null); }),
      client.e2ee.on('initError', (err) => { setError(err); }),
      client.e2ee.on('identityKeyChanged', (username, oldFp, newFp) => {
        setKeyChangeWarning({ username, oldFingerprint: oldFp, newFingerprint: newFp });
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [client]);

  const dismissKeyWarning = useCallback(() => setKeyChangeWarning(null), []);

  return {
    ready,
    error,
    keyChangeWarning,
    dismissKeyWarning,
    ownFingerprint: client?.e2ee.ownFingerprint ?? null,
    isRoomEncrypted: (room: string) => client?.e2ee.isRoomEncrypted(room) ?? false,
    enableRoom: (room: string) => client?.e2ee.enableRoom(room) ?? Promise.resolve({ ok: false, failedMembers: [] as string[] }),
    fetchRoomMeta: (room: string) => client?.e2ee.fetchRoomMeta(room) ?? Promise.resolve(null),
    getRoomMeta: (room: string) => client?.e2ee.getRoomMeta(room) ?? null,
    verifyUserKey: (username: string) => client?.e2ee.verifyUserKey(username) ?? Promise.resolve(null),
    rotateIdentityKey: () => client?.e2ee.rotateIdentityKey() ?? Promise.resolve(false),
  };
}
