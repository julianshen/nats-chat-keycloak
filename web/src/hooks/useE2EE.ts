import { useState, useEffect } from 'react';
import type { ChatClient } from '../lib/chat-client';

export function useE2EE(client: ChatClient | null) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    setReady(client.e2ee.isReady);

    const unsubs = [
      client.e2ee.on('ready', () => { setReady(true); setError(null); }),
      client.e2ee.on('initError', (err) => { setError(err); }),
    ];
    return () => unsubs.forEach(u => u());
  }, [client]);

  return {
    ready,
    error,
    isRoomEncrypted: (room: string) => client?.e2ee.isRoomEncrypted(room) ?? false,
    enableRoom: (room: string) => client?.e2ee.enableRoom(room) ?? Promise.resolve({ ok: false, failedMembers: [] as string[] }),
    fetchRoomMeta: (room: string) => client?.e2ee.fetchRoomMeta(room) ?? Promise.resolve(null),
    getRoomMeta: (room: string) => client?.e2ee.getRoomMeta(room) ?? null,
  };
}
