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
  const isRoomEncrypted = useCallback((room: string) => client?.e2ee.isRoomEncrypted(room) ?? false, [client]);
  const enableRoom = useCallback((room: string) => client?.e2ee.enableRoom(room) ?? Promise.resolve({ ok: false, failedMembers: [] as string[] }), [client]);
  const fetchRoomMeta = useCallback((room: string) => client?.e2ee.fetchRoomMeta(room) ?? Promise.resolve(null), [client]);
  const getRoomMeta = useCallback((room: string) => client?.e2ee.getRoomMeta(room) ?? null, [client]);
  const verifyUserKey = useCallback((username: string) => client?.e2ee.verifyUserKey(username) ?? Promise.resolve(null), [client]);
  const rotateIdentityKey = useCallback(() => client?.e2ee.rotateIdentityKey() ?? Promise.resolve(false), [client]);

  return {
    ready,
    error,
    keyChangeWarning,
    dismissKeyWarning,
    ownFingerprint: client?.e2ee.ownFingerprint ?? null,
    isRoomEncrypted,
    enableRoom,
    fetchRoomMeta,
    getRoomMeta,
    verifyUserKey,
    rotateIdentityKey,
  };
}
