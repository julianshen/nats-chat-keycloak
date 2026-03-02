import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { NatsConnection, StringCodec, Subscription } from 'nats.ws';
import { useNats } from './NatsProvider';
import { useAuth } from './AuthProvider';
import type { ChatMessage } from '../types';
import type { Translation } from '../components/MessageList';
import { tracedHeaders, startActionSpan, tracedHeadersWithContext } from '../utils/tracing';
import { routeAppMessage } from '../lib/AppBridge';

export interface PresenceMember {
  userId: string;
  status: string;
}

export interface MessageUpdate {
  text?: string;
  editedAt?: number;
  isDeleted?: boolean;
  reactions?: Record<string, string[]>;
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
  /** Mark a room as read (resets its unread count). Pass latestTimestamp to publish read position for messages not in live state. */
  markAsRead: (room: string, latestTimestamp?: number) => void;
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
  /** Fetch read receipts on demand for a room (request/reply to read-receipt-service) */
  fetchReadReceipts: (room: string) => Promise<Array<{userId: string, lastRead: number}>>;
  /** Edit/delete mutations keyed by "{timestamp}-{user}" for applying to history messages */
  messageUpdates: Record<string, MessageUpdate>;
  /** Translation results keyed by msgKey (timestamp-user) */
  translationResults: Record<string, Translation>;
  /** Clear a translation result (e.g. before re-translating to a new language) */
  clearTranslation: (msgKey: string) => void;
  /** Whether the translation service is available */
  translationAvailable: boolean;
  /** Mark translation service as unavailable (triggers recovery polling) */
  markTranslationUnavailable: () => void;
  /** Per-room unread mention counts */
  mentionCounts: Record<string, number>;
  /** Total unread mentions across all rooms */
  totalMentions: number;
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
  fetchReadReceipts: () => Promise.resolve([]),
  messageUpdates: {},
  translationResults: {},
  clearTranslation: () => {},
  translationAvailable: false,
  markTranslationUnavailable: () => {},
  mentionCounts: {},
  totalMentions: 0,
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
  const [messageUpdates, setMessageUpdates] = useState<Record<string, MessageUpdate>>({});
  const [translationResults, setTranslationResults] = useState<Record<string, Translation>>({});
  const [translationAvailable, setTranslationAvailable] = useState(false);
  const [mentionCounts, setMentionCounts] = useState<Record<string, number>>({});
  const connIdRef = useRef(crypto.randomUUID().slice(0, 8));
  const readUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subRef = useRef<Subscription | null>(null);
  const roomSubsRef = useRef<Map<string, { msgSub: Subscription; presSub: Subscription }>>(new Map());
  const joinedRoomsRef = useRef<Set<string>>(new Set());
  const activeRoomRef = useRef<string | null>(null);
  const messagesByRoomRef = useRef<Record<string, ChatMessage[]>>({});

  // Keep ref in sync with state so markAsRead can read latest without re-creating its identity
  messagesByRoomRef.current = messagesByRoom;

  /** Process a single room chat message (edit/delete/react/normal).
   *  Shared by both room.msg.* subscriptions and deliver.*.chat.* (private room) delivery. */
  const processRoomChatMessage = useCallback((data: ChatMessage, roomKey: string, username: string) => {
    // Handle edit actions
    if (data.action === 'edit') {
      const updateKey = `${data.timestamp}-${data.user}`;
      setMessageUpdates((prev) => ({
        ...prev,
        [updateKey]: { text: data.text, editedAt: data.timestamp },
      }));
      setMessagesByRoom((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const key of Object.keys(next)) {
          const updated = next[key].map((m) =>
            m.timestamp === data.timestamp && m.user === data.user
              ? { ...m, text: data.text, editedAt: data.timestamp }
              : m
          );
          if (updated !== next[key]) {
            next[key] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setThreadMessagesByThreadId((prev) => {
        const next = { ...prev };
        for (const tid of Object.keys(next)) {
          next[tid] = next[tid].map((m) =>
            m.timestamp === data.timestamp && m.user === data.user
              ? { ...m, text: data.text, editedAt: data.timestamp }
              : m
          );
        }
        return next;
      });
      return;
    }

    // Handle delete actions
    if (data.action === 'delete') {
      const updateKey = `${data.timestamp}-${data.user}`;
      setMessageUpdates((prev) => ({
        ...prev,
        [updateKey]: { isDeleted: true, text: '' },
      }));
      setMessagesByRoom((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const key of Object.keys(next)) {
          const updated = next[key].map((m) =>
            m.timestamp === data.timestamp && m.user === data.user
              ? { ...m, isDeleted: true, text: '' }
              : m
          );
          if (updated !== next[key]) {
            next[key] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setThreadMessagesByThreadId((prev) => {
        const next = { ...prev };
        for (const tid of Object.keys(next)) {
          next[tid] = next[tid].map((m) =>
            m.timestamp === data.timestamp && m.user === data.user
              ? { ...m, isDeleted: true, text: '' }
              : m
          );
        }
        return next;
      });
      return;
    }

    // Handle react actions
    if (data.action === 'react' && data.emoji && data.targetUser) {
      const updateKey = `${data.timestamp}-${data.targetUser}`;

      const toggleReaction = (reactions: Record<string, string[]> | undefined, emoji: string, userId: string): Record<string, string[]> => {
        const prev = reactions ? { ...reactions } : {};
        const users = prev[emoji] ? [...prev[emoji]] : [];
        const idx = users.indexOf(userId);
        if (idx >= 0) {
          users.splice(idx, 1);
          if (users.length === 0) {
            delete prev[emoji];
          } else {
            prev[emoji] = users;
          }
        } else {
          prev[emoji] = [...users, userId];
        }
        return prev;
      };

      setMessageUpdates((prev) => {
        const existing = prev[updateKey];
        const newReactions = toggleReaction(existing?.reactions, data.emoji!, data.user);
        return { ...prev, [updateKey]: { ...existing, reactions: newReactions } };
      });
      setMessagesByRoom((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          next[key] = next[key].map((m) =>
            m.timestamp === data.timestamp && m.user === data.targetUser
              ? { ...m, reactions: toggleReaction(m.reactions, data.emoji!, data.user) }
              : m
          );
        }
        return next;
      });
      setThreadMessagesByThreadId((prev) => {
        const next = { ...prev };
        for (const tid of Object.keys(next)) {
          next[tid] = next[tid].map((m) =>
            m.timestamp === data.timestamp && m.user === data.targetUser
              ? { ...m, reactions: toggleReaction(m.reactions, data.emoji!, data.user) }
              : m
          );
        }
        return next;
      });
      return;
    }

    // Normal chat message — add to room timeline (dedup by timestamp+user)
    const isDupRoom = (messagesByRoomRef.current[roomKey] || []).some(
      (m) => m.timestamp === data.timestamp && m.user === data.user
    );
    if (isDupRoom) return;

    setMessagesByRoom((prev) => {
      const existing = prev[roomKey] || [];
      return {
        ...prev,
        [roomKey]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
      };
    });

    // Increment unread count if this room is not currently active
    if (roomKey !== activeRoomRef.current && data.user !== '__system__') {
      setUnreadCounts((prev) => ({
        ...prev,
        [roomKey]: (prev[roomKey] || 0) + 1,
      }));
      if (data.mentions?.includes(username)) {
        setMentionCounts((prev) => ({
          ...prev,
          [roomKey]: (prev[roomKey] || 0) + 1,
        }));
      }
    }
  }, [setMessageUpdates, setMessagesByRoom, setThreadMessagesByThreadId, setUnreadCounts, setMentionCounts]);

  /** Fetch full message content from the msg.get API (capability-based: unpredictable notifyId). */
  const fetchMessageContent = useCallback(async (
    natsConn: NatsConnection,
    codec: ReturnType<typeof StringCodec>,
    notifyId: string,
    room: string,
  ): Promise<ChatMessage | null> => {
    try {
      const payload = JSON.stringify({ notifyId, room });
      const { headers: fetchHdr } = tracedHeaders();
      const reply = await natsConn.request('msg.get', codec.encode(payload), { timeout: 5000, headers: fetchHdr });
      const data = JSON.parse(codec.decode(reply.data));
      if (data.error) {
        console.log('[Messages] msg.get error:', data.error);
        return null;
      }
      return data as ChatMessage;
    } catch (err) {
      console.log('[Messages] msg.get failed:', err);
      return null;
    }
  }, []);

  /** Set up per-room subscriptions for room.notify.{memberKey} and room.presence.{memberKey}.
   *  Called from joinRoom and from reconnect logic.
   *  room.notify.* delivers lightweight notifications (ID stream) — no message content.
   *  Full content is fetched on demand via msg.get (permission-checked). */
  const setupRoomSubscriptions = useCallback((
    natsConn: NatsConnection,
    codec: ReturnType<typeof StringCodec>,
    memberKey: string,
    room: string,
    username: string,
  ) => {
    const notifySub = natsConn.subscribe(`room.notify.${memberKey}`);
    const presSub = natsConn.subscribe(`room.presence.${memberKey}`);
    roomSubsRef.current.set(memberKey, { msgSub: notifySub, presSub });

    // --- room.notify handler (notification ID stream) ---
    (async () => {
      try {
        for await (const msg of notifySub) {
          try {
            const notification = JSON.parse(codec.decode(msg.data)) as {
              notifyId: string; room: string; action: string; user: string;
              timestamp?: number; threadId?: string;
              emoji?: string; targetUser?: string;
            };

            // Delete and react can be applied directly from the notification (no content needed)
            if (notification.action === 'delete' && notification.timestamp && notification.user) {
              const deleteMsg: ChatMessage = {
                user: notification.user, text: '', timestamp: notification.timestamp,
                room: notification.room, action: 'delete',
              };
              if (notification.threadId) {
                // Thread delete — apply to thread messages
                const updateKey = `${notification.timestamp}-${notification.user}`;
                setMessageUpdates((prev) => ({ ...prev, [updateKey]: { isDeleted: true, text: '' } }));
                setThreadMessagesByThreadId((prev) => {
                  const next = { ...prev };
                  for (const tid of Object.keys(next)) {
                    next[tid] = next[tid].map((m) =>
                      m.timestamp === notification.timestamp && m.user === notification.user
                        ? { ...m, isDeleted: true, text: '' } : m
                    );
                  }
                  return next;
                });
              } else {
                processRoomChatMessage(deleteMsg, room, username);
              }
              continue;
            }

            if (notification.action === 'react' && notification.emoji && notification.targetUser && notification.timestamp) {
              const reactMsg: ChatMessage = {
                user: notification.user, text: '', timestamp: notification.timestamp,
                room: notification.room, action: 'react',
                emoji: notification.emoji, targetUser: notification.targetUser,
              };
              if (notification.threadId) {
                // Thread react — apply to thread messages
                const updateKey = `${notification.timestamp}-${notification.targetUser}`;
                const toggleReaction = (reactions: Record<string, string[]> | undefined, emoji: string, userId: string): Record<string, string[]> => {
                  const prev = reactions ? { ...reactions } : {};
                  const users = prev[emoji] ? [...prev[emoji]] : [];
                  const idx = users.indexOf(userId);
                  if (idx >= 0) { users.splice(idx, 1); if (users.length === 0) delete prev[emoji]; else prev[emoji] = users; }
                  else { prev[emoji] = [...users, userId]; }
                  return prev;
                };
                setMessageUpdates((prev) => {
                  const existing = prev[updateKey];
                  const newReactions = toggleReaction(existing?.reactions, notification.emoji!, notification.user);
                  return { ...prev, [updateKey]: { ...existing, reactions: newReactions } };
                });
                setThreadMessagesByThreadId((prev) => {
                  const next = { ...prev };
                  for (const tid of Object.keys(next)) {
                    next[tid] = next[tid].map((m) =>
                      m.timestamp === notification.timestamp && m.user === notification.targetUser
                        ? { ...m, reactions: toggleReaction(m.reactions, notification.emoji!, notification.user) } : m
                    );
                  }
                  return next;
                });
              } else {
                processRoomChatMessage(reactMsg, room, username);
              }
              continue;
            }

            // Thread notifications: update reply count; only fetch content if needed
            if (notification.threadId && (notification.action === 'message' || !notification.action)) {
              setReplyCounts((prev) => ({
                ...prev,
                [notification.threadId!]: (prev[notification.threadId!] || 0) + 1,
              }));
              // Fetch the thread reply content (ThreadPanel will show it if open)
              const fullMsg = await fetchMessageContent(natsConn, codec, notification.notifyId, room);
              if (fullMsg) {
                setThreadMessagesByThreadId((prev) => ({
                  ...prev,
                  [notification.threadId!]: [...(prev[notification.threadId!] || []).slice(-(MAX_MESSAGES_PER_ROOM - 1)), fullMsg],
                }));
              }
              continue;
            }

            // For all other actions (message, edit, sticker, system, thread edits):
            // fetch full content from msg.get, then process normally
            const fullMsg = await fetchMessageContent(natsConn, codec, notification.notifyId, room);
            if (fullMsg) {
              processRoomChatMessage(fullMsg, room, username);
            }
          } catch { /* ignore malformed */ }
        }
      } catch (err) {
        console.log(`[Messages] room.notify.${memberKey} subscription ended:`, err);
      }
    })();

    // --- room.presence handler (presence diffs — unchanged) ---
    (async () => {
      try {
        for await (const msg of presSub) {
          try {
            const diff = JSON.parse(codec.decode(msg.data)) as {
              action: string; userId: string; status?: string;
            };
            const presenceRoomKey = memberKey === '__admin__chat' ? '__admin__' : room;

            setOnlineUsers((prev) => {
              const current = prev[presenceRoomKey] || [];
              switch (diff.action) {
                case 'online':
                case 'status': {
                  const existing = current.findIndex(m => m.userId === diff.userId);
                  const member: PresenceMember = { userId: diff.userId, status: diff.status || 'online' };
                  if (existing >= 0) {
                    const updated = [...current];
                    updated[existing] = member;
                    return { ...prev, [presenceRoomKey]: updated };
                  }
                  return { ...prev, [presenceRoomKey]: [...current, member] };
                }
                case 'offline': {
                  return { ...prev, [presenceRoomKey]: current.filter(m => m.userId !== diff.userId) };
                }
                default:
                  return prev;
              }
            });
          } catch { /* ignore */ }
        }
      } catch (err) {
        console.log(`[Presence] room.presence.${memberKey} subscription ended:`, err);
      }
    })();
  }, [processRoomChatMessage, fetchMessageContent]);

  // Subscribe to deliver.{username}.> once on connect
  useEffect(() => {
    if (!nc || !connected || !userInfo) return;

    const deliverSubject = `deliver.${userInfo.username}.>`;
    const sub = nc.subscribe(deliverSubject);
    subRef.current = sub;

    // Publish online status on connect
    const onlinePayload = JSON.stringify({ userId: userInfo.username, status: 'online' });
    const { headers: presHdr } = tracedHeaders();
    nc.publish('presence.update', sc.encode(onlinePayload), { headers: presHdr });

    // Start heartbeat: immediate + 10s interval
    const connId = connIdRef.current;
    const heartbeatPayload = JSON.stringify({ userId: userInfo.username, connId });
    const { headers: hbHdr } = tracedHeaders();
    nc.publish('presence.heartbeat', sc.encode(heartbeatPayload), { headers: hbHdr });
    const heartbeatInterval = setInterval(() => {
      const { headers: hbIntHdr } = tracedHeaders();
      nc.publish('presence.heartbeat', sc.encode(heartbeatPayload), { headers: hbIntHdr });
    }, 10_000);

    // Re-join all previously joined rooms (handles NATS reconnect — rebuilds server-side membership)
    const previousRooms = new Set(joinedRoomsRef.current);
    if (previousRooms.size > 0) {
      // Clear old per-room subscriptions (dead from previous nc)
      roomSubsRef.current.clear();
      joinedRoomsRef.current.clear();

      for (const memberKey of previousRooms) {
        joinedRoomsRef.current.add(memberKey);

        const joinPayload = JSON.stringify({ userId: userInfo.username });
        const { headers: rejoinHdr } = tracedHeaders();
        nc.publish(`room.join.${memberKey}`, sc.encode(joinPayload), { headers: rejoinHdr });

        // Re-subscribe to per-room subjects
        const room = memberKey === '__admin__chat' ? '__admin__' : memberKey;
        setupRoomSubscriptions(nc, sc, memberKey, room, userInfo.username);
      }
      console.log(`[Messages] Re-joined ${previousRooms.size} rooms after reconnect`);
    }

    (async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as ChatMessage;

            // Extract room from deliver subject: deliver.{userId}.{type}.{roomOrExtra...}
            const parts = msg.subject.split('.');
            if (parts.length < 4) continue;
            const subjectType = parts[2]; // "chat", "admin", "translate", "app"
            const roomName = parts.slice(3).join('.'); // handle room names with dots

            // Presence now arrives via room.presence.* — skip any legacy deliver presence
            if (subjectType === 'presence') continue;

            // Handle translation responses (deliver.{userId}.translate.response)
            if (subjectType === 'translate') {
              try {
                const translateData = JSON.parse(sc.decode(msg.data)) as {
                  translatedText: string;
                  targetLang: string;
                  msgKey: string;
                  done?: boolean;
                };
                if (translateData.msgKey) {
                  setTranslationResults((prev) => ({
                    ...prev,
                    [translateData.msgKey]: {
                      text: (prev[translateData.msgKey]?.text || '') + translateData.translatedText,
                      lang: translateData.targetLang,
                      done: translateData.done ?? true,
                    },
                  }));
                }
              } catch {
                console.log('[Messages] Failed to parse translation response');
              }
              continue;
            }

            // Handle app messages (deliver.{userId}.app.{appId}.{room}.{event...})
            if (subjectType === 'app') {
              if (parts.length >= 6) {
                const appId = parts[3];
                const appRoom = parts[4];
                const event = parts.slice(5).join('.');
                try {
                  const appData = JSON.parse(sc.decode(msg.data));
                  routeAppMessage(appId, appRoom, event, appData);
                } catch (e) {
                  console.error('[Messages] Failed to parse app message:', e);
                }
              }
              continue;
            }

            // DM notifications arrive via deliver.{userId}.notify.{room}
            // (per-user delivery to hide DM metadata from non-participants).
            // Private rooms use per-room room.notify.{room} like public rooms.
            // Same notification format as room.notify.* — fetch content via msg.get.
            if (subjectType === 'notify') {
              try {
                const notification = JSON.parse(sc.decode(msg.data)) as {
                  notifyId: string; room: string; action: string; user: string;
                  timestamp?: number; threadId?: string;
                  emoji?: string; targetUser?: string;
                };
                const dmRoom = notification.room;

                // Delete/react applied directly from notification
                if (notification.action === 'delete' && notification.timestamp && notification.user) {
                  const deleteMsg: ChatMessage = {
                    user: notification.user, text: '', timestamp: notification.timestamp,
                    room: dmRoom, action: 'delete',
                  };
                  if (notification.threadId) {
                    const updateKey = `${notification.timestamp}-${notification.user}`;
                    setMessageUpdates((prev) => ({ ...prev, [updateKey]: { isDeleted: true, text: '' } }));
                    setThreadMessagesByThreadId((prev) => {
                      const next = { ...prev };
                      for (const tid of Object.keys(next)) {
                        next[tid] = next[tid].map((m) =>
                          m.timestamp === notification.timestamp && m.user === notification.user
                            ? { ...m, isDeleted: true, text: '' } : m
                        );
                      }
                      return next;
                    });
                  } else {
                    processRoomChatMessage(deleteMsg, dmRoom, userInfo?.username || '');
                  }
                  continue;
                }

                if (notification.action === 'react' && notification.emoji && notification.targetUser && notification.timestamp) {
                  const reactMsg: ChatMessage = {
                    user: notification.user, text: '', timestamp: notification.timestamp,
                    room: dmRoom, action: 'react',
                    emoji: notification.emoji, targetUser: notification.targetUser,
                  };
                  if (notification.threadId) {
                    const updateKey = `${notification.timestamp}-${notification.targetUser}`;
                    const toggleReaction = (reactions: Record<string, string[]> | undefined, emoji: string, uid: string): Record<string, string[]> => {
                      const prev = reactions ? { ...reactions } : {};
                      const users = prev[emoji] ? [...prev[emoji]] : [];
                      const idx = users.indexOf(uid);
                      if (idx >= 0) { users.splice(idx, 1); if (users.length === 0) delete prev[emoji]; else prev[emoji] = users; }
                      else { prev[emoji] = [...users, uid]; }
                      return prev;
                    };
                    setMessageUpdates((prev) => {
                      const existing = prev[updateKey];
                      const newReactions = toggleReaction(existing?.reactions, notification.emoji!, notification.user);
                      return { ...prev, [updateKey]: { ...existing, reactions: newReactions } };
                    });
                    setThreadMessagesByThreadId((prev) => {
                      const next = { ...prev };
                      for (const tid of Object.keys(next)) {
                        next[tid] = next[tid].map((m) =>
                          m.timestamp === notification.timestamp && m.user === notification.targetUser
                            ? { ...m, reactions: toggleReaction(m.reactions, notification.emoji!, notification.user) } : m
                        );
                      }
                      return next;
                    });
                  } else {
                    processRoomChatMessage(reactMsg, dmRoom, userInfo?.username || '');
                  }
                  continue;
                }

                // Thread notifications
                if (notification.threadId && (notification.action === 'message' || !notification.action)) {
                  setReplyCounts((prev) => ({
                    ...prev,
                    [notification.threadId!]: (prev[notification.threadId!] || 0) + 1,
                  }));
                  const fullMsg = await fetchMessageContent(nc, sc, notification.notifyId, dmRoom);
                  if (fullMsg) {
                    setThreadMessagesByThreadId((prev) => ({
                      ...prev,
                      [notification.threadId!]: [...(prev[notification.threadId!] || []).slice(-(MAX_MESSAGES_PER_ROOM - 1)), fullMsg],
                    }));
                  }
                  continue;
                }

                // All other actions: fetch full content from msg.get
                const fullMsg = await fetchMessageContent(nc, sc, notification.notifyId, dmRoom);
                if (fullMsg) {
                  processRoomChatMessage(fullMsg, dmRoom, userInfo?.username || '');
                }
              } catch { /* ignore malformed */ }
              continue;
            }

            // Admin messages still arrive via deliver.{userId}.admin.{room}
            if (subjectType === 'admin') {
              const roomKey = '__admin__';

              if (data.action === 'edit') {
                const updateKey = `${data.timestamp}-${data.user}`;
                setMessageUpdates((prev) => ({
                  ...prev,
                  [updateKey]: { text: data.text, editedAt: data.timestamp },
                }));
                setMessagesByRoom((prev) => {
                  const next = { ...prev };
                  let changed = false;
                  for (const key of Object.keys(next)) {
                    const updated = next[key].map((m) =>
                      m.timestamp === data.timestamp && m.user === data.user
                        ? { ...m, text: data.text, editedAt: data.timestamp }
                        : m
                    );
                    if (updated !== next[key]) {
                      next[key] = updated;
                      changed = true;
                    }
                  }
                  return changed ? next : prev;
                });
                continue;
              }
              if (data.action === 'delete') {
                const updateKey = `${data.timestamp}-${data.user}`;
                setMessageUpdates((prev) => ({
                  ...prev,
                  [updateKey]: { isDeleted: true, text: '' },
                }));
                setMessagesByRoom((prev) => {
                  const next = { ...prev };
                  let changed = false;
                  for (const key of Object.keys(next)) {
                    const updated = next[key].map((m) =>
                      m.timestamp === data.timestamp && m.user === data.user
                        ? { ...m, isDeleted: true, text: '' }
                        : m
                    );
                    if (updated !== next[key]) {
                      next[key] = updated;
                      changed = true;
                    }
                  }
                  return changed ? next : prev;
                });
                continue;
              }
              if (data.action === 'react' && data.emoji && data.targetUser) {
                const updateKey = `${data.timestamp}-${data.targetUser}`;
                const toggleReaction = (reactions: Record<string, string[]> | undefined, emoji: string, userId: string): Record<string, string[]> => {
                  const prev = reactions ? { ...reactions } : {};
                  const users = prev[emoji] ? [...prev[emoji]] : [];
                  const idx = users.indexOf(userId);
                  if (idx >= 0) {
                    users.splice(idx, 1);
                    if (users.length === 0) { delete prev[emoji]; } else { prev[emoji] = users; }
                  } else {
                    prev[emoji] = [...users, userId];
                  }
                  return prev;
                };
                setMessageUpdates((prev) => {
                  const existing = prev[updateKey];
                  const newReactions = toggleReaction(existing?.reactions, data.emoji!, data.user);
                  return { ...prev, [updateKey]: { ...existing, reactions: newReactions } };
                });
                setMessagesByRoom((prev) => {
                  const next = { ...prev };
                  for (const key of Object.keys(next)) {
                    next[key] = next[key].map((m) =>
                      m.timestamp === data.timestamp && m.user === data.targetUser
                        ? { ...m, reactions: toggleReaction(m.reactions, data.emoji!, data.user) }
                        : m
                    );
                  }
                  return next;
                });
                continue;
              }

              const isDupAdmin = (messagesByRoomRef.current[roomKey] || []).some(
                (m) => m.timestamp === data.timestamp && m.user === data.user
              );
              if (isDupAdmin) continue;

              setMessagesByRoom((prev) => {
                const existing = prev[roomKey] || [];
                return {
                  ...prev,
                  [roomKey]: [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data],
                };
              });

              if (roomKey !== activeRoomRef.current && data.user !== '__system__') {
                setUnreadCounts((prev) => ({
                  ...prev,
                  [roomKey]: (prev[roomKey] || 0) + 1,
                }));
                if (data.mentions?.includes(userInfo.username)) {
                  setMentionCounts((prev) => ({
                    ...prev,
                    [roomKey]: (prev[roomKey] || 0) + 1,
                  }));
                }
              }
              continue;
            }

            // Unknown subject type — skip
          } catch {
            // Ignore malformed messages
          }
        }
      } catch (err) {
        console.log('[Messages] Deliver subscription ended:', err);
      }
    })();

    return () => {
      clearInterval(heartbeatInterval);
      sub.unsubscribe();
      subRef.current = null;
      // Clean up per-room subscriptions
      for (const [, subs] of roomSubsRef.current) {
        subs.msgSub.unsubscribe();
        subs.presSub.unsubscribe();
      }
      roomSubsRef.current.clear();
    };
  }, [nc, connected, userInfo, sc, setupRoomSubscriptions, processRoomChatMessage, fetchMessageContent]);

  const joinRoom = useCallback((room: string) => {
    if (!nc || !connected || !userInfo) return;

    const memberKey = roomToMemberKey(room);
    if (joinedRoomsRef.current.has(memberKey)) return;
    joinedRoomsRef.current.add(memberKey);

    const action = startActionSpan('join_room', { 'chat.room': room, 'chat.user': userInfo.username, 'chat.action': 'join' });
    try {
      // Publish join event to fanout-service and presence-service
      const joinSubject = `room.join.${memberKey}`;
      const payload = JSON.stringify({ userId: userInfo.username });
      const { headers: joinHdr } = tracedHeadersWithContext(action.ctx, 'room.join.publish');
      nc.publish(joinSubject, sc.encode(payload), { headers: joinHdr });

      // Subscribe to per-room subjects (room.msg.* and room.presence.*)
      setupRoomSubscriptions(nc, sc, memberKey, room, userInfo.username);

      console.log(`[Messages] Joined room: ${room} (key: ${memberKey})`);

      // Request initial presence for this room from presence-service
      const { headers: presQHdr } = tracedHeadersWithContext(action.ctx, 'presence.room.request');
      nc.request(`presence.room.${memberKey}`, sc.encode(''), { timeout: 5000, headers: presQHdr })
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
          action.end();
        })
        .catch((err) => {
          console.log('[Presence] Presence request failed:', err);
          action.end(err instanceof Error ? err : new Error(String(err)));
        });
    } catch (err) {
      action.end(err instanceof Error ? err : new Error(String(err)));
    }

  }, [nc, connected, userInfo, sc, setupRoomSubscriptions]);

  const leaveRoom = useCallback((room: string) => {
    if (!nc || !connected || !userInfo) return;

    const memberKey = roomToMemberKey(room);
    if (!joinedRoomsRef.current.has(memberKey)) return;
    joinedRoomsRef.current.delete(memberKey);

    // Unsubscribe from per-room subjects
    const subs = roomSubsRef.current.get(memberKey);
    if (subs) {
      subs.msgSub.unsubscribe();
      subs.presSub.unsubscribe();
      roomSubsRef.current.delete(memberKey);
    }

    // Publish leave event to fanout-service and presence-service
    const leaveSubject = `room.leave.${memberKey}`;
    const payload = JSON.stringify({ userId: userInfo.username });
    const { headers: leaveHdr } = tracedHeaders();
    nc.publish(leaveSubject, sc.encode(payload), { headers: leaveHdr });
    console.log(`[Messages] Left room: ${room} (key: ${memberKey})`);
  }, [nc, connected, userInfo, sc]);

  // Publish leave events and disconnect on tab close / refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!nc || !userInfo) return;
      const payload = sc.encode(JSON.stringify({ userId: userInfo.username }));
      for (const memberKey of joinedRoomsRef.current) {
        const { headers: ulHdr } = tracedHeaders();
        nc.publish(`room.leave.${memberKey}`, payload, { headers: ulHdr });
      }
      // Publish graceful disconnect with connId (presence-service handles offline detection)
      const disconnectPayload = sc.encode(JSON.stringify({ userId: userInfo.username, connId: connIdRef.current }));
      const { headers: discHdr } = tracedHeaders();
      nc.publish('presence.disconnect', disconnectPayload, { headers: discHdr });
      // Flush synchronously to ensure messages are sent before the page unloads
      try { nc.flush(); } catch { /* best-effort */ }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [nc, userInfo, sc]);

  const markTranslationUnavailable = useCallback(() => {
    setTranslationAvailable(false);
  }, []);

  // Ping translation service: once on connect, then poll every 60s only while unavailable
  const translationAvailableRef = useRef(false);
  translationAvailableRef.current = translationAvailable;

  useEffect(() => {
    if (!nc || !connected) {
      setTranslationAvailable(false);
      return;
    }

    const ping = () => {
      nc.request('translate.ping', sc.encode(''), { timeout: 2000 })
        .then((reply) => {
          try {
            const data = JSON.parse(sc.decode(reply.data)) as { available: boolean };
            setTranslationAvailable(data.available);
          } catch {
            setTranslationAvailable(false);
          }
        })
        .catch(() => {
          setTranslationAvailable(false);
        });
    };

    ping();
    const interval = setInterval(() => {
      if (!translationAvailableRef.current) ping();
    }, 60_000);
    return () => clearInterval(interval);
  }, [nc, connected, sc]);

  const setStatus = useCallback((status: string) => {
    if (!nc || !connected || !userInfo) return;
    const payload = JSON.stringify({ userId: userInfo.username, status });
    const { headers: statusHdr } = tracedHeaders();
    nc.publish('presence.update', sc.encode(payload), { headers: statusHdr });
    setCurrentStatus(status);
    console.log(`[Presence] Status set to: ${status}`);
  }, [nc, connected, userInfo, sc]);

  const getMessages = useCallback((room: string) => {
    return messagesByRoom[room] || [];
  }, [messagesByRoom]);

  const markAsRead = useCallback((room: string, latestTimestamp?: number) => {
    activeRoomRef.current = room;
    setUnreadCounts((prev) => {
      if (!prev[room]) return prev;
      const next = { ...prev };
      delete next[room];
      return next;
    });
    setMentionCounts((prev) => {
      if (!prev[room]) return prev;
      const next = { ...prev };
      delete next[room];
      return next;
    });

    // Publish read position to read-receipt-service (debounced at 3s)
    if (!nc || !connected || !userInfo) return;
    if (readUpdateTimerRef.current) clearTimeout(readUpdateTimerRef.current);
    readUpdateTimerRef.current = setTimeout(() => {
      let latestTs = latestTimestamp;
      if (!latestTs) {
        const messages = messagesByRoomRef.current[room] || [];
        if (messages.length === 0) return;
        latestTs = messages[messages.length - 1].timestamp;
      }
      const memberKey = roomToMemberKey(room);
      const payload = JSON.stringify({ userId: userInfo.username, lastRead: latestTs });
      const { headers: readHdr } = tracedHeaders();
      nc.publish(`read.update.${memberKey}`, sc.encode(payload), { headers: readHdr });
    }, 3000);
  }, [nc, connected, userInfo, sc]);

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

  const fetchReadReceipts = useCallback(async (room: string): Promise<Array<{userId: string, lastRead: number}>> => {
    if (!nc || !connected) return [];
    const memberKey = roomToMemberKey(room);
    try {
      const { headers: readStateHdr } = tracedHeaders();
      const reply = await nc.request(`read.state.${memberKey}`, sc.encode(''), { timeout: 5000, headers: readStateHdr });
      return JSON.parse(sc.decode(reply.data)) as Array<{userId: string; lastRead: number}>;
    } catch (err) {
      console.log('[ReadReceipt] Failed to fetch read receipts:', err);
      return [];
    }
  }, [nc, connected, sc]);

  const clearTranslation = useCallback((msgKey: string) => {
    setTranslationResults((prev) => {
      if (!prev[msgKey]) return prev;
      const next = { ...prev };
      delete next[msgKey];
      return next;
    });
  }, []);

  const totalMentions = Object.values(mentionCounts).reduce((sum, n) => sum + n, 0);

  return (
    <MessageContext.Provider value={{
      getMessages, joinRoom, leaveRoom, unreadCounts, markAsRead,
      onlineUsers, setStatus, currentStatus,
      getThreadMessages, replyCounts, activeThread, openThread, closeThread,
      fetchReadReceipts, messageUpdates, translationResults, clearTranslation,
      translationAvailable, markTranslationUnavailable, mentionCounts, totalMentions,
    }}>
      {children}
    </MessageContext.Provider>
  );
};
