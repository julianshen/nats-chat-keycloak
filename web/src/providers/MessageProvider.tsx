import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { Subscription } from 'nats.ws';
import { useNats } from './NatsProvider';
import { useAuth } from './AuthProvider';
import type { ChatMessage } from '../types';

export interface PresenceMember {
  userId: string;
  status: string;
}

interface MessageContextType {
  /** Messages for a specific room */
  getMessages: (room: string) => ChatMessage[];
  /** Join a room (subscribes to fan-out delivery and publishes join event) */
  joinRoom: (room: string) => void;
  /** Leave a room (publishes leave event) */
  leaveRoom: (room: string) => void;
  /** Unread message counts per room */
  unreadCounts: Record<string, number>;
  /** Mark a room as read (resets its unread count) */
  markAsRead: (room: string) => void;
  /** Online users per room with status info */
  onlineUsers: Record<string, PresenceMember[]>;
  /** Set the current user's presence status */
  setStatus: (status: string) => void;
  /** Current user's status */
  currentStatus: string;
  getThreadMessages: (threadId: string) => ChatMessage[];
  replyCounts: Record<string, number>;
  activeThread: { room: string; threadId: string; parentMessage: ChatMessage } | null;
  openThread: (room: string, parentMessage: ChatMessage) => void;
  closeThread: () => void;
}

const MessageContext = createContext<MessageContextType>({
  getMessages: () => [],
  joinRoom: () => {},
  leaveRoom: () => {},
  unreadCounts: {},
  markAsRead: () => {},
  onlineUsers: {},
  setStatus: () => {},
  currentStatus: 'online',
  getThreadMessages: () => [],
  replyCounts: {},
  activeThread: null,
  openThread: () => {},
  closeThread: () => {},
});

export const useMessages = () => useContext(MessageContext);

/** Maps a room name to the membership key used by the fanout-service */
function roomToMemberKey(room: string): string {
  if (room === '__admin__') return '__admin__chat';
  return room;
}

const MAX_MESSAGES_PER_ROOM = 200;

export const MessageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { nc, connected, sc } = useNats();
  const { userInfo } = useAuth();
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, PresenceMember[]>>({});
  const [currentStatus, setCurrentStatus] = useState<string>('online');
  const [threadMessagesByThreadId, setThreadMessagesByThreadId] = useState<Record<string, ChatMessage[]>>({});
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [activeThread, setActiveThread] = useState<{ room: string; threadId: string; parentMessage: ChatMessage } | null>(null);
  const subRef = useRef<Subscription | null>(null);
  const joinedRoomsRef = useRef<Set<string>>(new Set());
  const activeRoomRef = useRef<string | null>(null);

  // Subscribe to deliver.{username}.> once on connect
  useEffect(() => {
    if (!nc || !connected || !userInfo) return;

    const deliverSubject = `deliver.${userInfo.username}.>`;
    const sub = nc.subscribe(deliverSubject);
    subRef.current = sub;

    // Publish online status on connect
    const onlinePayload = JSON.stringify({ userId: userInfo.username, status: 'online' });
    nc.publish('presence.update', sc.encode(onlinePayload));

    (async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as ChatMessage;

            // Extract room from deliver subject: deliver.{userId}.chat.{room} or deliver.{userId}.admin.{room}
            const parts = msg.subject.split('.');
            // parts = ["deliver", userId, "chat"|"admin"|"presence", roomName]
            if (parts.length < 4) continue;
            const subjectType = parts[2]; // "chat", "admin", or "presence"
            const roomName = parts.slice(3).join('.'); // handle room names with dots

            // Handle presence events (deliver.{userId}.presence.{room})
            if (subjectType === 'presence') {
              const presenceData = JSON.parse(sc.decode(msg.data)) as {
                type: string;
                userId: string;
                room: string;
                members: PresenceMember[];
              };
              // Map admin room keys back: __admin__chat → __admin__
              const presenceRoomKey = roomName === '__admin__chat' ? '__admin__' : roomName;
              setOnlineUsers((prev) => ({
                ...prev,
                [presenceRoomKey]: presenceData.members,
              }));
              continue;
            }

            // Determine room key for internal use
            let roomKey: string;
            if (subjectType === 'admin') {
              roomKey = '__admin__';
            } else {
              roomKey = roomName;
            }

            // Check if this is a thread message: deliver.{userId}.chat.{room}.thread.{threadId}
            // roomName would be "{room}.thread.{threadId}" in that case
            const threadMatch = roomKey.match(/^([^.]+)\.thread\.(.+)$/);
            if (threadMatch) {
              const threadId = threadMatch[2];
              const parentRoom = threadMatch[1];

              // Store in thread messages
              setThreadMessagesByThreadId((prev) => {
                const existing = prev[threadId] || [];
                return {
                  ...prev,
                  [threadId]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
                };
              });

              // Increment reply count
              setReplyCounts((prev) => ({
                ...prev,
                [threadId]: (prev[threadId] || 0) + 1,
              }));

              // If broadcast, also add to main timeline
              if (data.broadcast) {
                setMessagesByRoom((prev) => {
                  const existing = prev[parentRoom] || [];
                  return {
                    ...prev,
                    [parentRoom]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
                  };
                });
              }

              continue;
            }

            setMessagesByRoom((prev) => {
              const existing = prev[roomKey] || [];
              return {
                ...prev,
                [roomKey]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
              };
            });

            // Increment unread count if this room is not currently active
            if (roomKey !== activeRoomRef.current) {
              setUnreadCounts((prev) => ({
                ...prev,
                [roomKey]: (prev[roomKey] || 0) + 1,
              }));
            }
          } catch {
            // Ignore malformed messages
          }
        }
      } catch (err) {
        console.log('[Messages] Deliver subscription ended:', err);
      }
    })();

    return () => {
      sub.unsubscribe();
      subRef.current = null;
    };
  }, [nc, connected, userInfo, sc]);

  const joinRoom = useCallback((room: string) => {
    if (!nc || !connected || !userInfo) return;

    const memberKey = roomToMemberKey(room);
    if (joinedRoomsRef.current.has(memberKey)) return;
    joinedRoomsRef.current.add(memberKey);

    // Publish join event to fanout-service and presence-service
    const joinSubject = `room.join.${memberKey}`;
    const payload = JSON.stringify({ userId: userInfo.username });
    nc.publish(joinSubject, sc.encode(payload));
    console.log(`[Messages] Joined room: ${room} (key: ${memberKey})`);

    // Request initial presence for this room from presence-service
    nc.request(`presence.room.${memberKey}`, sc.encode(''), { timeout: 5000 })
      .then((reply) => {
        try {
          const members = JSON.parse(sc.decode(reply.data)) as PresenceMember[];
          const presenceRoomKey = room;
          setOnlineUsers((prev) => ({
            ...prev,
            [presenceRoomKey]: members,
          }));
        } catch {
          console.log('[Presence] Failed to parse presence response');
        }
      })
      .catch((err) => {
        console.log('[Presence] Presence request failed:', err);
      });
  }, [nc, connected, userInfo, sc]);

  const leaveRoom = useCallback((room: string) => {
    if (!nc || !connected || !userInfo) return;

    const memberKey = roomToMemberKey(room);
    if (!joinedRoomsRef.current.has(memberKey)) return;
    joinedRoomsRef.current.delete(memberKey);

    // Publish leave event to fanout-service and presence-service
    const leaveSubject = `room.leave.${memberKey}`;
    const payload = JSON.stringify({ userId: userInfo.username });
    nc.publish(leaveSubject, sc.encode(payload));
    console.log(`[Messages] Left room: ${room} (key: ${memberKey})`);
  }, [nc, connected, userInfo, sc]);

  // Publish leave events and offline status on tab close / refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!nc || !userInfo) return;
      const payload = sc.encode(JSON.stringify({ userId: userInfo.username }));
      for (const memberKey of joinedRoomsRef.current) {
        nc.publish(`room.leave.${memberKey}`, payload);
      }
      // Publish offline status
      const offlinePayload = sc.encode(JSON.stringify({ userId: userInfo.username, status: 'offline' }));
      nc.publish('presence.update', offlinePayload);
      // Flush synchronously to ensure messages are sent before the page unloads
      try { nc.flush(); } catch { /* best-effort */ }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [nc, userInfo, sc]);

  const setStatus = useCallback((status: string) => {
    if (!nc || !connected || !userInfo) return;
    const payload = JSON.stringify({ userId: userInfo.username, status });
    nc.publish('presence.update', sc.encode(payload));
    setCurrentStatus(status);
    console.log(`[Presence] Status set to: ${status}`);
  }, [nc, connected, userInfo, sc]);

  const getMessages = useCallback((room: string) => {
    return messagesByRoom[room] || [];
  }, [messagesByRoom]);

  const markAsRead = useCallback((room: string) => {
    activeRoomRef.current = room;
    setUnreadCounts((prev) => {
      if (!prev[room]) return prev;
      const next = { ...prev };
      delete next[room];
      return next;
    });
  }, []);

  const getThreadMessages = useCallback((threadId: string) => {
    return threadMessagesByThreadId[threadId] || [];
  }, [threadMessagesByThreadId]);

  const openThread = useCallback((room: string, parentMessage: ChatMessage) => {
    const threadId = `${room}-${parentMessage.timestamp}`;
    setActiveThread({ room, threadId, parentMessage });
  }, []);

  const closeThread = useCallback(() => {
    setActiveThread(null);
  }, []);

  return (
    <MessageContext.Provider value={{
      getMessages, joinRoom, leaveRoom, unreadCounts, markAsRead,
      onlineUsers, setStatus, currentStatus,
      getThreadMessages, replyCounts, activeThread, openThread, closeThread
    }}>
      {children}
    </MessageContext.Provider>
  );
};
