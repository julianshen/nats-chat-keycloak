import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { Subscription } from 'nats.ws';
import { useNats } from './NatsProvider';
import { useAuth } from './AuthProvider';
import type { ChatMessage } from '../types';

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
}

const MessageContext = createContext<MessageContextType>({
  getMessages: () => [],
  joinRoom: () => {},
  leaveRoom: () => {},
  unreadCounts: {},
  markAsRead: () => {},
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
  const subRef = useRef<Subscription | null>(null);
  const joinedRoomsRef = useRef<Set<string>>(new Set());
  const activeRoomRef = useRef<string | null>(null);

  // Subscribe to deliver.{username}.> once on connect
  useEffect(() => {
    if (!nc || !connected || !userInfo) return;

    const deliverSubject = `deliver.${userInfo.username}.>`;
    const sub = nc.subscribe(deliverSubject);
    subRef.current = sub;

    (async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as ChatMessage;

            // Extract room from deliver subject: deliver.{userId}.chat.{room} or deliver.{userId}.admin.{room}
            const parts = msg.subject.split('.');
            // parts = ["deliver", userId, "chat"|"admin", roomName]
            if (parts.length < 4) continue;
            const subjectType = parts[2]; // "chat" or "admin"
            const roomName = parts.slice(3).join('.'); // handle room names with dots

            // Determine room key for internal use
            let roomKey: string;
            if (subjectType === 'admin') {
              roomKey = '__admin__';
            } else {
              roomKey = roomName;
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

    // Publish join event to fanout-service
    const joinSubject = `room.join.${memberKey}`;
    const payload = JSON.stringify({ userId: userInfo.username });
    nc.publish(joinSubject, sc.encode(payload));
    console.log(`[Messages] Joined room: ${room} (key: ${memberKey})`);
  }, [nc, connected, userInfo, sc]);

  const leaveRoom = useCallback((room: string) => {
    if (!nc || !connected || !userInfo) return;

    const memberKey = roomToMemberKey(room);
    if (!joinedRoomsRef.current.has(memberKey)) return;
    joinedRoomsRef.current.delete(memberKey);

    // Publish leave event to fanout-service
    const leaveSubject = `room.leave.${memberKey}`;
    const payload = JSON.stringify({ userId: userInfo.username });
    nc.publish(leaveSubject, sc.encode(payload));
    console.log(`[Messages] Left room: ${room} (key: ${memberKey})`);
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

  return (
    <MessageContext.Provider value={{ getMessages, joinRoom, leaveRoom, unreadCounts, markAsRead }}>
      {children}
    </MessageContext.Provider>
  );
};
