import { useState, useEffect } from 'react';
import type { ChatClient } from '../lib/chat-client';
import type { ChatMessage, MessageUpdate } from '../lib/chat-client/types';

function mapToRecord<V>(map: ReadonlyMap<string, V>): Record<string, V> {
  const obj: Record<string, V> = {};
  map.forEach((v, k) => { obj[k] = v; });
  return obj;
}

export function useMessages(client: ChatClient | null, room: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [mentions, setMentions] = useState(0);
  const [updates, setUpdates] = useState<Record<string, MessageUpdate>>({});
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!client || !room) return;

    const refresh = () => {
      setMessages([...client.messages.getMessages(room)]);
      const u = client.messages.getUnread(room);
      setUnread(u.count);
      setMentions(u.mentions);
      setUpdates(mapToRecord(client.messages.getUpdates()));
      setReplyCounts(mapToRecord(client.messages.getReplyCounts()));
    };

    refresh();

    const unsubs = [
      client.messages.on('message', (r) => {
        if (r === room) setMessages([...client.messages.getMessages(room)]);
      }),
      client.messages.on('updated', () => {
        setUpdates(mapToRecord(client.messages.getUpdates()));
      }),
      client.messages.on('unreadChanged', (r, count, ments) => {
        if (r === room) { setUnread(count); setMentions(ments); }
      }),
      client.messages.on('replyCountChanged', () => {
        setReplyCounts(mapToRecord(client.messages.getReplyCounts()));
      }),
      client.messages.on('historyLoaded', (r) => {
        if (r === room) setMessages([...client.messages.getMessages(room)]);
      }),
    ];

    return () => unsubs.forEach(u => u());
  }, [client, room]);

  return { messages, unread, mentions, updates, replyCounts };
}

export function useAllUnreads(client: ChatClient | null) {
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [mentionCounts, setMentionCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!client) return;

    const update = (room: string, count: number, ments: number) => {
      setUnreadCounts(prev => ({ ...prev, [room]: count }));
      setMentionCounts(prev => ({ ...prev, [room]: ments }));
    };

    const unsub = client.messages.on('unreadChanged', update);
    return unsub;
  }, [client]);

  const totalMentions = Object.values(mentionCounts).reduce((a, b) => a + b, 0);

  return { unreadCounts, mentionCounts, totalMentions };
}

export function useThreadMessages(client: ChatClient | null, threadId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!client || !threadId) return;
    setMessages([...client.messages.getThreadMessages(threadId)]);

    const unsub = client.messages.on('threadReply', (tid) => {
      if (tid === threadId) setMessages([...client.messages.getThreadMessages(threadId)]);
    });
    return unsub;
  }, [client, threadId]);

  return messages;
}
