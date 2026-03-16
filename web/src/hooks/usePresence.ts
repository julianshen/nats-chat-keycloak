import { useState, useEffect } from 'react';
import type { ChatClient } from '../lib/chat-client';

type PresenceMember = { userId: string; status: string };

export function usePresence(client: ChatClient | null, room: string | null) {
  const [onlineUsers, setOnlineUsers] = useState<PresenceMember[]>([]);

  useEffect(() => {
    if (!client || !room) return;
    setOnlineUsers(client.presence.getOnlineUsers(room));

    const unsub = client.presence.on('presenceChanged', (r, users) => {
      if (r === room) setOnlineUsers([...users]);
    });
    return unsub;
  }, [client, room]);

  return onlineUsers;
}

export function useStatus(client: ChatClient | null) {
  const [status, setStatus] = useState('online');

  useEffect(() => {
    if (!client) return;
    setStatus(client.presence.currentStatus);
  }, [client]);

  const updateStatus = (newStatus: string) => {
    if (client) {
      client.presence.setStatus(newStatus);
      setStatus(newStatus);
    }
  };

  return { status, setStatus: updateStatus };
}
