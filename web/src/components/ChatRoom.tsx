import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useChatClient } from '../hooks/useNatsChat';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../hooks/useMessages';
import { usePresence } from '../hooks/usePresence';
import { useE2EE } from '../hooks/useE2EE';
import { useTranslation } from '../hooks/useTranslation';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { ThreadPanel } from './ThreadPanel';
import type { ChatMessage, HistoryResponse, RoomInfo, UserSearchResult } from '../types';
import { tracedHeaders } from '../utils/tracing';
import { createAppBridge, destroyAppBridge } from '../lib/AppBridge';
import { sc } from '../lib/chat-client';

interface Props {
  room: string;
  isPrivateRoom?: boolean;
  onRoomRemoved?: (roomName: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  online: '#22c55e',
  away: '#f59e0b',
  busy: '#ef4444',
  offline: '#64748b',
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  outerContainer: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  innerContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    minWidth: 0,
  },
  roomHeader: {
    padding: '12px 20px',
    borderBottom: '1px solid #1e293b',
    background: '#0f172a',
  },
  roomName: {
    fontSize: '16px',
    fontWeight: 700,
    color: '#f1f5f9',
  },
  roomSubject: {
    fontSize: '12px',
    color: '#64748b',
    marginTop: '2px',
    fontFamily: 'monospace',
  },
  presenceBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '6px',
    overflowX: 'auto' as const,
  },
  presenceIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: '#94a3b8',
    flexShrink: 0,
  },
  memberPill: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: '#cbd5e1',
    background: '#1e293b',
    borderRadius: '10px',
    padding: '1px 8px',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  statusDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  errorBanner: {
    padding: '8px 20px',
    background: '#7f1d1d',
    color: '#fca5a5',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  tabBar: {
    display: 'flex',
    gap: '0',
    borderBottom: '1px solid #1e293b',
    background: '#0f172a',
    paddingLeft: '12px',
  },
  tab: {
    padding: '8px 16px',
    fontSize: '13px',
    color: '#94a3b8',
    cursor: 'pointer',
    background: 'none',
    borderTop: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    borderBottom: '2px solid transparent',
    fontFamily: 'inherit',
  },
  activeTab: {
    padding: '8px 16px',
    fontSize: '13px',
    color: '#f1f5f9',
    cursor: 'pointer',
    background: 'none',
    borderTop: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    borderBottom: '2px solid #3b82f6',
    fontFamily: 'inherit',
  },
  appContainer: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
  },
  channelActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '6px',
  },
  channelBtn: {
    padding: '4px 12px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    color: '#94a3b8',
    fontSize: '12px',
    cursor: 'pointer',
  },
  channelBtnDanger: {
    padding: '4px 12px',
    background: '#1e293b',
    border: '1px solid #7f1d1d',
    borderRadius: '6px',
    color: '#fca5a5',
    fontSize: '12px',
    cursor: 'pointer',
  },
  memberPanel: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '12px',
    zIndex: 50,
    minWidth: '200px',
    maxHeight: '300px',
    overflowY: 'auto' as const,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  memberItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 0',
    fontSize: '13px',
    color: '#cbd5e1',
  },
  memberRole: {
    fontSize: '10px',
    color: '#64748b',
    marginLeft: '4px',
  },
  kickBtn: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    fontSize: '11px',
    cursor: 'pointer',
    padding: '2px 6px',
  },
  inviteOverlay: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '12px',
    zIndex: 50,
    minWidth: '220px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  inviteInput: {
    width: '100%',
    padding: '6px 10px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '4px',
    color: '#e2e8f0',
    fontSize: '13px',
    outline: 'none',
    marginBottom: '4px',
    boxSizing: 'border-box' as const,
  },
  inviteResultItem: {
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#cbd5e1',
    borderRadius: '4px',
  },
};

// Map room name to NATS subject for publishing.
// Users publish via the ingest path: deliver.{userId}.send.{room}.
// The fanout-service validates sender + membership, then publishes to chat.{room}.
function roomToSubject(room: string, userId: string): string {
  if (room === '__admin__') return 'admin.chat';
  return `deliver.${userId}.send.${room}`;
}

export const ChatRoom: React.FC<Props> = ({ room, isPrivateRoom, onRoomRemoved }) => {
  const client = useChatClient();
  const nc = client?.connection.nc ?? null;
  const connected = client?.isConnected ?? false;
  const { userInfo } = useAuth();
  const { messages: liveMessages, updates: messageUpdates, replyCounts } = useMessages(client, room);
  const roomMembers = usePresence(client, room);
  const { enableRoom, fetchRoomMeta, error: e2eeInitError } = useE2EE(client);
  const { available: translationAvailable, results: translationResults, request: requestTranslation, clearResult: clearTranslation } = useTranslation(client);

  // Thread state (UI-local)
  const [activeThread, setActiveThread] = useState<{ room: string; threadId: string; parentMessage: ChatMessage } | null>(null);

  const openThread = useCallback((threadRoom: string, parentMessage: ChatMessage) => {
    const threadId = `${threadRoom}-${parentMessage.timestamp}`;
    setActiveThread({ room: threadRoom, threadId, parentMessage });
  }, []);

  const closeThread = useCallback(() => {
    setActiveThread(null);
  }, []);

  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [pubError, setPubError] = useState<string | null>(null);
  const [unreadAfterTs, setUnreadAfterTs] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [translatingKeys, setTranslatingKeys] = useState<Set<string>>(new Set());
  const [installedApps, setInstalledApps] = useState<Array<{id: string, name: string, componentUrl: string}>>([]);
  const [activeTab, setActiveTab] = useState<string>('chat');
  const appContainerRef = useRef<HTMLDivElement>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<UserSearchResult[]>([]);
  const inviteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [removedFromRoom, setRemovedFromRoom] = useState(false);
  const [e2eeEnabled, setE2eeEnabled] = useState(false);
  const [enablingE2EE, setEnablingE2EE] = useState(false);

  const subject = roomToSubject(room, userInfo?.username || '');

  // Join room and fetch history on mount
  useEffect(() => {
    if (!client || !connected) return;

    setHistoryMessages([]);
    setPubError(null);
    setUnreadAfterTs(null);
    setHasMore(true);
    setLoadingMore(false);
    setRemovedFromRoom(false);

    const fetchHistory = () => {
      // Join the room via ChatClient and mark as read
      client.joinRoom(room);
      client.messages.clearUnread(room);

      // Fetch user's own read position for the unread separator
      client.readReceipts.fetchReceipts(room).then((receipts) => {
        const own = receipts.find((r) => r.userId === userInfo?.username);
        if (own) setUnreadAfterTs(own.lastRead);
        else setUnreadAfterTs(0); // never read -> all messages are unread
      });

      // Fetch history from history-service via NATS request/reply
      // TODO: Replace with ChatClient method when history fetch is added to ChatClient
      const historySubject = `chat.history.${room}`;
      const { headers: histHdr } = tracedHeaders();
      nc!.request(historySubject, sc.encode(''), { timeout: 5000, headers: histHdr })
        .then((reply) => {
          try {
            const resp = JSON.parse(sc.decode(reply.data)) as HistoryResponse;
            if (resp.messages && resp.messages.length > 0) {
              setHistoryMessages(resp.messages);
            }
            setHasMore(resp.hasMore ?? false);
          } catch (e) {
            console.log('[NATS] Failed to parse history response', e);
          }
        })
        .catch((err) => {
          console.log('[NATS] History request failed (service may not be running):', err);
        });
    };

    // For private rooms, verify membership via room.info before fetching history
    if (isPrivateRoom && userInfo) {
      client.getRoomInfo(room)
        .then((info) => {
          if (info && info.type === 'private' && info.members && !info.members.some((m: any) => m.username === userInfo.username)) {
            setRemovedFromRoom(true);
            onRoomRemoved?.(room);
            return;
          }
          fetchHistory();
        })
        .catch(() => {
          // room service unreachable, proceed with fetch
          fetchHistory();
        });
    } else {
      fetchHistory();
    }
  }, [client, connected, subject, room, userInfo, isPrivateRoom, onRoomRemoved]);

  // Load older messages (triggered by scrolling to top)
  const loadMore = useCallback(() => {
    if (!nc || !connected || loadingMore || !hasMore || historyMessages.length === 0) return;

    const oldestTs = historyMessages[0].timestamp;
    setLoadingMore(true);

    // TODO: Replace with ChatClient method when paginated history is added to ChatClient
    const historySubject = `chat.history.${room}`;
    const body = JSON.stringify({ before: oldestTs });
    const { headers: moreHdr } = tracedHeaders();
    nc.request(historySubject, sc.encode(body), { timeout: 5000, headers: moreHdr })
      .then((reply) => {
        try {
          const resp = JSON.parse(sc.decode(reply.data)) as HistoryResponse;
          if (resp.messages && resp.messages.length > 0) {
            setHistoryMessages((prev) => [...resp.messages, ...prev]);
          }
          setHasMore(resp.hasMore ?? false);
        } catch (e) {
          console.log('[NATS] Failed to parse loadMore response', e);
        }
      })
      .catch((err) => {
        console.log('[NATS] Load more request failed:', err);
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [nc, connected, loadingMore, hasMore, historyMessages, room]);

  // Combine history messages with live messages from fan-out delivery
  const allMessagesRaw = React.useMemo(() => {
    let combined: ChatMessage[];
    if (historyMessages.length === 0) combined = liveMessages;
    else if (liveMessages.length === 0) combined = historyMessages;
    else {
      const lastHistoryTs = historyMessages[historyMessages.length - 1]?.timestamp || 0;
      const newLiveMessages = liveMessages.filter((m) => m.timestamp > lastHistoryTs);
      combined = [...historyMessages, ...newLiveMessages];
    }
    // Apply edit/delete mutations from live events to history messages
    if (Object.keys(messageUpdates).length > 0) {
      combined = combined.map((m) => {
        const update = messageUpdates[`${m.timestamp}-${m.user}`];
        if (!update) return m;
        return { ...m, ...update };
      });
    }
    // Filter out thread-only replies (messages with threadId that aren't broadcast)
    return combined.filter((m) => !m.threadId || m.broadcast);
  }, [historyMessages, liveMessages, messageUpdates]);

  // Decrypt live E2EE messages client-side (history is already plaintext from DB)
  const [decryptedTexts, setDecryptedTexts] = useState<Record<string, string>>({});
  const attemptedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!e2eeEnabled || !client) return;
    let cancelled = false;
    const pending: Array<{ key: string; msg: ChatMessage }> = [];
    for (const m of allMessagesRaw) {
      if (!m.e2ee && !m.e2eeEpoch) continue; // not encrypted
      const key = `${m.room}-${m.timestamp}-${m.user}`;
      if (attemptedKeysRef.current.has(key)) continue; // already attempted
      pending.push({ key, msg: m });
    }
    if (pending.length === 0) return;
    (async () => {
      const results: Record<string, string> = {};
      for (const { key, msg } of pending) {
        if (cancelled) return;
        attemptedKeysRef.current.add(key);
        const result = await client.e2ee.decrypt(msg);
        if (result.status === 'decrypted') {
          results[key] = result.text;
        } else if (result.status === 'no_key') {
          // Remove from attempted so we can retry when key becomes available
          attemptedKeysRef.current.delete(key);
          console.warn(`[E2EE] No key for message ${key}, epoch ${(result as any).epoch}`);
        } else if (result.status === 'failed') {
          // Show placeholder instead of raw ciphertext
          results[key] = '\u{1F512} Unable to decrypt this message';
          console.warn(`[E2EE] ${(result as any).error} for message ${key}`);
        }
      }
      if (!cancelled && Object.keys(results).length > 0) {
        setDecryptedTexts(prev => ({ ...prev, ...results }));
      }
    })();
    return () => { cancelled = true; };
  }, [allMessagesRaw, e2eeEnabled, client]);

  // Apply decrypted texts to produce final message list
  const allMessages = React.useMemo(() => {
    if (Object.keys(decryptedTexts).length === 0) return allMessagesRaw;
    return allMessagesRaw.map(m => {
      const key = `${m.room}-${m.timestamp}-${m.user}`;
      const decrypted = decryptedTexts[key];
      if (decrypted !== undefined) return { ...m, text: decrypted };
      return m;
    });
  }, [allMessagesRaw, decryptedTexts]);

  // Clear decrypted texts cache when room changes
  useEffect(() => {
    setDecryptedTexts({});
    attemptedKeysRef.current.clear();
  }, [room]);

  // Adjust unread separator to account for own messages (if you sent a message, you saw everything up to that point)
  const effectiveUnreadAfterTs = React.useMemo(() => {
    if (unreadAfterTs == null) return null;
    let effective = unreadAfterTs;
    for (const m of allMessages) {
      if (m.user === userInfo?.username && m.timestamp > effective) {
        effective = m.timestamp;
      }
    }
    return effective;
  }, [unreadAfterTs, allMessages, userInfo]);

  // Update read position whenever messages change (covers both history load and live messages)
  useEffect(() => {
    if (!client || allMessages.length === 0) return;
    const latestTs = allMessages[allMessages.length - 1].timestamp;
    client.readReceipts.markRead(room, latestTs);
  }, [allMessages, room, client]);

  // Publish a message using ChatClient
  const handleSend = useCallback(
    async (text: string, mentions?: string[]) => {
      if (!client || !connected || !userInfo) return;

      try {
        await client.sendMessage(room, text, {
          mentions,
        });
        setPubError(null);
      } catch (err: any) {
        console.error('[ChatClient] Send error:', err);
        setPubError(err.message || 'Failed to send message');
      }
    },
    [client, connected, userInfo, room],
  );

  const handleEdit = useCallback(async (message: ChatMessage, newText: string) => {
    if (!client || !connected || !userInfo) return;
    try {
      await client.editMessage(room, message.timestamp, message.user, newText);
    } catch (err) {
      console.error('[ChatClient] Edit error:', err);
    }
  }, [client, connected, userInfo, room]);

  const handleDelete = useCallback((message: ChatMessage) => {
    if (!client || !connected || !userInfo) return;
    client.deleteMessage(room, message.timestamp, message.user);
  }, [client, connected, userInfo, room]);

  const handleReact = useCallback((message: ChatMessage, emoji: string) => {
    if (!client || !connected || !userInfo) return;
    client.reactToMessage(room, message.timestamp, message.user, emoji);
  }, [client, connected, userInfo, room]);

  const handleReplyClick = useCallback((message: ChatMessage) => {
    openThread(room, message);
  }, [room, openThread]);

  const handleReadByClick = useCallback(async (_msg: ChatMessage) => {
    if (!client) return [];
    return client.readReceipts.fetchReceipts(room);
  }, [room, client]);

  const handleSendSticker = useCallback(
    async (stickerUrl: string) => {
      if (!client || !connected || !userInfo) return;

      // For stickers, we need to use the raw nc.publish since ChatClient.sendMessage
      // doesn't have a sticker-specific path
      // TODO: Add sticker support to ChatClient.sendMessage
      const timestamp = Date.now();
      let msgText = '';
      let e2eeField: { epoch: number; v: number } | undefined;

      // In E2EE rooms, encrypt the sticker URL as the message text
      if (e2eeEnabled) {
        const encrypted = await client.e2ee.encrypt(room, `sticker:${stickerUrl}`, userInfo.username, timestamp);
        if (encrypted) {
          msgText = encrypted.ciphertext;
          e2eeField = { epoch: encrypted.epoch, v: 1 };
        } else {
          setPubError('Encryption failed -- sticker not sent.');
          return;
        }
      }

      const msg: ChatMessage = {
        user: userInfo.username,
        text: msgText,
        timestamp,
        room,
        ...(!e2eeField ? { stickerUrl } : {}),
        ...(e2eeField ? { e2ee: e2eeField } : {}),
      };

      try {
        // TODO: Replace with ChatClient method when sticker send is added
        const { headers: sendHdr } = tracedHeaders();
        client.connection.nc!.publish(subject, sc.encode(JSON.stringify(msg)), { headers: sendHdr });
        setPubError(null);
      } catch (err: any) {
        console.error('[NATS] Publish sticker error:', err);
        setPubError(err.message || 'Failed to send sticker');
      }
    },
    [client, connected, userInfo, room, subject, e2eeEnabled],
  );

  const handleTranslate = useCallback((message: ChatMessage, targetLang: string) => {
    if (!client || !connected || !userInfo) return;
    const key = `${message.timestamp}-${message.user}`;
    clearTranslation(key);
    setTranslatingKeys(prev => new Set(prev).add(key));
    requestTranslation(message.text, targetLang, key);
  }, [client, connected, userInfo, requestTranslation, clearTranslation]);

  // Clear translatingKeys when translation result arrives (the new hook provides just text strings)
  // Since the new useTranslation hook doesn't track 'done', we clear translating state when a result appears
  useEffect(() => {
    setTranslatingKeys(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const key of prev) {
        if (translationResults[key] !== undefined) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [translationResults]);

  // Detect translation service failure: if any key is not done after 15s, mark unavailable
  useEffect(() => {
    if (translatingKeys.size === 0) return;
    const timer = setTimeout(() => {
      for (const key of translatingKeys) {
        if (translationResults[key] === undefined) {
          client?.translation.markUnavailable();
          setTranslatingKeys(new Set());
          break;
        }
      }
    }, 15_000);
    return () => clearTimeout(timer);
  }, [translatingKeys, translationResults, client]);

  // Fetch E2EE meta for private rooms and DMs
  const isDm = room.startsWith('dm-');
  useEffect(() => {
    if (!client || !connected) return;
    if (isPrivateRoom || isDm) {
      fetchRoomMeta(room).then((meta) => {
        setE2eeEnabled(meta?.enabled ?? false);
      });
    } else {
      setE2eeEnabled(false);
    }
  }, [client, connected, room, isPrivateRoom, isDm, fetchRoomMeta]);

  // Handle enable E2EE button click
  const handleEnableE2EE = useCallback(async () => {
    if (enablingE2EE) return;
    setEnablingE2EE(true);
    try {
      await enableRoom(room);
      setE2eeEnabled(true);
    } finally {
      setEnablingE2EE(false);
    }
  }, [room, enableRoom, enablingE2EE]);

  // Fetch room info for private rooms
  useEffect(() => {
    if (!client || !connected || !isPrivateRoom) {
      setRoomInfo(null);
      return;
    }
    client.getRoomInfo(room)
      .then((info) => {
        if (info && !(info as any).error) setRoomInfo(info);
      })
      .catch((err) => {
        console.warn('[Room] Failed to fetch room info:', err);
      });
  }, [client, connected, room, isPrivateRoom]);

  // Debounced user search for invite
  useEffect(() => {
    if (!showInvite || !client || !connected) return;
    if (inviteDebounceRef.current) clearTimeout(inviteDebounceRef.current);
    const trimmed = inviteQuery.trim();
    if (trimmed.length === 0) { setInviteResults([]); return; }
    inviteDebounceRef.current = setTimeout(async () => {
      try {
        const results = await client.searchUsers(trimmed);
        const memberNames = new Set(roomInfo?.members?.map(m => m.username) || []);
        setInviteResults((results as UserSearchResult[]).filter(u => !memberNames.has(u.username)));
      } catch { setInviteResults([]); }
    }, 300);
    return () => { if (inviteDebounceRef.current) clearTimeout(inviteDebounceRef.current); };
  }, [inviteQuery, showInvite, client, connected, roomInfo]);

  const handleInvite = useCallback(async (username: string) => {
    if (!client || !connected || !userInfo) return;
    try {
      const resp = await client.inviteUser(room, username);
      if (resp?.ok) {
        // Refresh room info
        const info = await client.getRoomInfo(room);
        if (info) setRoomInfo(info as RoomInfo);
        setShowInvite(false);
        setInviteQuery('');
        setInviteResults([]);
      }
    } catch (err) {
      console.warn('[Room] Invite request failed:', err);
    }
  }, [client, connected, userInfo, room]);

  const handleKick = useCallback(async (username: string) => {
    if (!client || !connected || !userInfo) return;
    try {
      const resp = await client.kickUser(room, username);
      if (resp?.ok) {
        const info = await client.getRoomInfo(room);
        if (info) setRoomInfo(info as RoomInfo);
      }
    } catch (err) {
      console.warn('[Room] Kick request failed:', err);
    }
  }, [client, connected, userInfo, room]);

  const handleLeaveRoom = useCallback(async () => {
    if (!client || !connected || !userInfo) return;
    try {
      await client.departRoom(room);
    } catch (err) {
      console.warn('[Room] Leave room request failed:', err);
    }
  }, [client, connected, userInfo, room]);

  const myRoomRole = roomInfo?.members?.find(m => m.username === userInfo?.username)?.role;
  const canManage = myRoomRole === 'owner' || myRoomRole === 'admin';

  // Fetch installed apps for this room (skip DM rooms)
  useEffect(() => {
    if (!client || !connected || isDm) return;
    client.getInstalledApps(room)
      .then((apps) => {
        setInstalledApps(apps.map((a: any) => ({ id: a.id, name: a.name, componentUrl: a.componentUrl })));
      })
      .catch(() => { setInstalledApps([]); });
    setActiveTab('chat');
  }, [client, connected, room, isDm]);

  // Load and mount app Web Component when activeTab changes to an app
  useEffect(() => {
    const container = appContainerRef.current;
    if (!container || activeTab === 'chat' || !nc || !userInfo) return;

    const app = installedApps.find(a => a.id === activeTab);
    if (!app) return;

    const tagName = `room-app-${app.id}`;

    const mountApp = () => {
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      const el = document.createElement(tagName);
      container.appendChild(el);
      // TODO: AppBridge still needs raw nc — get it from client.connection.nc
      const bridge = createAppBridge(nc, sc, app.id, room, userInfo.username);
      (el as any).setBridge(bridge);
    };

    if (customElements.get(tagName)) {
      mountApp();
    } else {
      const script = document.createElement('script');
      script.src = app.componentUrl;
      script.onload = () => mountApp();
      script.onerror = () => console.error(`[Apps] Failed to load ${app.componentUrl}`);
      document.head.appendChild(script);
    }

    return () => {
      destroyAppBridge(app.id, room);
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    };
  }, [activeTab, installedApps, nc, room, userInfo]);

  const displayRoom = isDm
    ? (() => {
        const parts = room.replace('dm-', '').split('-');
        const other = parts.find((u) => u !== userInfo?.username) || parts[1];
        return other;
      })()
    : room === '__admin__' ? 'admin-channel' : room;
  const onlineCount = roomMembers.filter((m) => m.status !== 'offline').length;

  // Build a status map for MessageList
  const statusMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of roomMembers) {
      map[m.userId] = m.status;
    }
    return map;
  }, [roomMembers]);

  // Build translations prop for MessageList (convert Record<string, string> to Record<string, Translation>)
  const translationsForList = React.useMemo(() => {
    const result: Record<string, { text: string; lang: string; done?: boolean }> = {};
    for (const [key, text] of Object.entries(translationResults)) {
      result[key] = { text, lang: '', done: true };
    }
    return result;
  }, [translationResults]);

  return (
    <div style={styles.outerContainer}>
      <div style={styles.innerContainer}>
        <div style={{ ...styles.roomHeader, position: 'relative' as const }}>
          <div style={styles.roomName}>
            {isDm ? '@ ' : isPrivateRoom ? '\uD83D\uDD12 ' : '# '}{displayRoom}
            {e2eeEnabled && (
              <span style={{ marginLeft: '8px', fontSize: '12px', color: '#22c55e', fontWeight: 400 }} title="End-to-end encrypted">
                \uD83D\uDD10 E2EE
              </span>
            )}
          </div>
          <div style={styles.roomSubject}>subject: {subject}</div>
          {isPrivateRoom && roomInfo && (
            <div style={styles.channelActions}>
              <button
                style={styles.channelBtn}
                onClick={() => { setShowMembers(!showMembers); setShowInvite(false); }}
              >
                {roomInfo.memberCount || roomInfo.members?.length || 0} members
              </button>
              {canManage && (
                <button
                  style={styles.channelBtn}
                  onClick={() => { setShowInvite(!showInvite); setShowMembers(false); }}
                >
                  Invite
                </button>
              )}
              {canManage && !e2eeEnabled && (
                <button
                  style={{ ...styles.channelBtn, color: '#22c55e', borderColor: '#166534' }}
                  onClick={handleEnableE2EE}
                  disabled={enablingE2EE}
                >
                  {enablingE2EE ? 'Enabling...' : '\uD83D\uDD10 Enable E2EE'}
                </button>
              )}
              <button style={styles.channelBtnDanger} onClick={handleLeaveRoom}>
                Leave
              </button>
            </div>
          )}
          {showMembers && roomInfo?.members && (
            <div style={styles.memberPanel}>
              {roomInfo.members.map((m) => (
                <div key={m.username} style={styles.memberItem}>
                  <span>
                    {m.username}
                    {m.role !== 'member' && <span style={styles.memberRole}>({m.role})</span>}
                  </span>
                  {canManage && m.username !== userInfo?.username && m.role !== 'owner' && (
                    <button style={styles.kickBtn} onClick={() => handleKick(m.username)}>Remove</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {showInvite && (
            <div style={styles.inviteOverlay}>
              <input
                style={styles.inviteInput}
                placeholder="Search users to invite..."
                value={inviteQuery}
                onChange={(e) => setInviteQuery(e.target.value)}
                autoFocus
              />
              {inviteResults.map((user) => (
                <div
                  key={user.username}
                  style={styles.inviteResultItem}
                  onClick={() => handleInvite(user.username)}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#334155'; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
                >
                  {user.username}
                  {(user.firstName || user.lastName) && (
                    <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '4px' }}>
                      ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {roomMembers.length > 0 && (
            <div style={styles.presenceBar}>
              <span style={styles.presenceIndicator}>
                <span style={{ ...styles.statusDot, backgroundColor: '#22c55e' }} />
                {onlineCount} online
              </span>
              {roomMembers.map((member) => (
                <span key={member.userId} style={styles.memberPill}>
                  <span style={{ ...styles.statusDot, backgroundColor: STATUS_COLORS[member.status] || '#64748b' }} />
                  {member.userId}
                </span>
              ))}
            </div>
          )}
        </div>
        {!isDm && installedApps.length > 0 && (
          <div style={styles.tabBar}>
            <button
              style={activeTab === 'chat' ? styles.activeTab : styles.tab}
              onClick={() => setActiveTab('chat')}
            >
              Chat
            </button>
            {installedApps.map(app => (
              <button
                key={app.id}
                style={activeTab === app.id ? styles.activeTab : styles.tab}
                onClick={() => setActiveTab(app.id)}
              >
                {app.name}
              </button>
            ))}
          </div>
        )}
        {removedFromRoom ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '14px', flexDirection: 'column' as const, gap: '8px' }}>
            <span style={{ fontSize: '32px' }}>&#128274;</span>
            <span>You are no longer a member of this room.</span>
          </div>
        ) : activeTab === 'chat' ? (
          <>
            {(pubError || e2eeInitError) && (
              <div style={styles.errorBanner}>
                {pubError || e2eeInitError}
              </div>
            )}
            <MessageList
              messages={allMessages}
              currentUser={userInfo?.username || ''}
              memberStatusMap={statusMap}
              replyCounts={replyCounts}
              onReplyClick={handleReplyClick}
              onReadByClick={handleReadByClick}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onReact={handleReact}
              onTranslate={translationAvailable && !e2eeEnabled ? handleTranslate : undefined}
              translations={translationsForList}
              translatingKeys={translatingKeys}
              unreadAfterTs={effectiveUnreadAfterTs}
              onLoadMore={loadMore}
              hasMore={hasMore}
              loadingMore={loadingMore}
            />
            <MessageInput onSend={handleSend} onSendSticker={handleSendSticker} disabled={!connected} room={displayRoom} client={client} e2eeEnabled={e2eeEnabled} />
          </>
        ) : (
          <div ref={appContainerRef} style={styles.appContainer} />
        )}
      </div>
      {activeThread && activeThread.room === room && (
        <ThreadPanel
          room={room}
          threadId={activeThread.threadId}
          parentMessage={activeThread.parentMessage}
          onClose={closeThread}
        />
      )}
    </div>
  );
};
