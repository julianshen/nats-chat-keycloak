import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useChatClient } from '../hooks/useNatsChat';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../hooks/useMessages';
import { usePresence } from '../hooks/usePresence';
import { useE2EE } from '../hooks/useE2EE';
import { useTranslation } from '../hooks/useTranslation';
import { useDecryptMessages } from '../hooks/useDecryptMessages';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { ThreadPanel } from './ThreadPanel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Hash, Lock, AtSign, Users, UserPlus, Shield, LogOut, X, Loader2, LockKeyhole } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage, HistoryResponse, RoomInfo, UserSearchResult } from '../types';
import { tracedHeaders } from '../utils/tracing';
import { STATUS_COLORS, dmOtherUser } from '../utils/chat-utils';
import { createAppBridge, destroyAppBridge } from '../lib/AppBridge';
import { sc } from '../lib/chat-client';

interface Props {
  room: string;
  isPrivateRoom?: boolean;
  onRoomRemoved?: (roomName: string) => void;
}

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

  // Keep MessageStore unread tracking aligned with the currently visible room.
  useEffect(() => {
    if (!client) return;
    client.messages.setActiveRoom(room);
    return () => {
      client.messages.setActiveRoom(null);
    };
  }, [client, room]);

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
  const allMessages = useDecryptMessages(allMessagesRaw, e2eeEnabled, client, room);

  // Adjust unread separator to account for own messages
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

  // Update read position whenever messages change
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

      const timestamp = Date.now();
      let msgText = '';
      let e2eeField: { epoch: number; v: number } | undefined;

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

  // Clear translatingKeys when translation result arrives
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

  // Detect translation service failure
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
    ? dmOtherUser(room, userInfo?.username)
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

  // Build translations prop for MessageList
  const translationsForList = React.useMemo(() => {
    const result: Record<string, { text: string; lang: string; done?: boolean }> = {};
    for (const [key, text] of Object.entries(translationResults)) {
      result[key] = { text, lang: '', done: true };
    }
    return result;
  }, [translationResults]);

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Room Header */}
        <div className="relative px-5 py-3 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              {isDm ? <AtSign className="h-4 w-4 text-primary" /> : isPrivateRoom ? <Lock className="h-4 w-4 text-amber-500" /> : <Hash className="h-4 w-4 text-muted-foreground" />}
              {displayRoom}
            </div>
            {e2eeEnabled && (
              <Badge variant="outline" className="text-xs text-green-500 border-green-500/30 gap-1">
                <LockKeyhole className="h-3 w-3" />
                E2EE
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 font-mono">subject: {subject}</div>

          {isPrivateRoom && roomInfo && (
            <div className="flex items-center gap-2 mt-2">
              <Popover open={showMembers} onOpenChange={(open) => { setShowMembers(open); if (open) setShowInvite(false); }}>
                <PopoverTrigger className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 h-7 text-xs font-medium hover:bg-accent transition-colors cursor-pointer">
                    <Users className="h-3 w-3" />
                    {roomInfo.memberCount || roomInfo.members?.length || 0} members
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[220px] p-3">
                  <div className="space-y-1.5">
                    {roomInfo.members?.map((m) => (
                      <div key={m.username} className="flex items-center justify-between text-sm">
                        <span className="text-foreground">
                          {m.username}
                          {m.role !== 'member' && <span className="text-[10px] text-muted-foreground ml-1">({m.role})</span>}
                        </span>
                        {canManage && m.username !== userInfo?.username && m.role !== 'owner' && (
                          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-destructive text-xs hover:text-destructive" onClick={() => handleKick(m.username)}>
                            Remove
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {canManage && (
                <Popover open={showInvite} onOpenChange={(open) => { setShowInvite(open); if (open) setShowMembers(false); }}>
                  <PopoverTrigger className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 h-7 text-xs font-medium hover:bg-accent transition-colors cursor-pointer">
                      <UserPlus className="h-3 w-3" />
                      Invite
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[240px] p-3">
                    <Input
                      className="h-8 text-xs mb-2"
                      placeholder="Search users to invite..."
                      value={inviteQuery}
                      onChange={(e) => setInviteQuery(e.target.value)}
                      autoFocus
                    />
                    <div className="space-y-0.5">
                      {inviteResults.map((user) => (
                        <button
                          key={user.username}
                          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-sm text-foreground hover:bg-accent cursor-pointer transition-colors"
                          onClick={() => handleInvite(user.username)}
                        >
                          {user.username}
                          {(user.firstName || user.lastName) && (
                            <span className="text-xs text-muted-foreground">
                              ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              {canManage && !e2eeEnabled && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 text-green-500 border-green-500/30 hover:text-green-400"
                  onClick={handleEnableE2EE}
                  disabled={enablingE2EE}
                >
                  <LockKeyhole className="h-3 w-3" />
                  {enablingE2EE ? 'Enabling...' : 'Enable E2EE'}
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5 text-destructive border-destructive/30 hover:text-destructive"
                onClick={handleLeaveRoom}
              >
                <LogOut className="h-3 w-3" />
                Leave
              </Button>
            </div>
          )}

          {roomMembers.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 overflow-x-auto">
              <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 mr-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                {onlineCount} online
              </span>
              {roomMembers.map((member) => (
                <span key={member.userId} className="flex items-center gap-1 text-xs text-foreground/70 bg-muted rounded-full px-2 py-0.5 whitespace-nowrap shrink-0">
                  <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_COLORS[member.status] || 'bg-slate-500')} />
                  {member.userId}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Tab bar for installed apps */}
        {!isDm && installedApps.length > 0 && (
          <div className="flex border-b border-border bg-card pl-3">
            <button
              className={cn(
                'px-4 py-2 text-sm transition-colors border-b-2',
                activeTab === 'chat'
                  ? 'text-foreground border-primary font-medium'
                  : 'text-muted-foreground border-transparent hover:text-foreground',
              )}
              onClick={() => setActiveTab('chat')}
            >
              Chat
            </button>
            {installedApps.map(app => (
              <button
                key={app.id}
                className={cn(
                  'px-4 py-2 text-sm transition-colors border-b-2',
                  activeTab === app.id
                    ? 'text-foreground border-primary font-medium'
                    : 'text-muted-foreground border-transparent hover:text-foreground',
                )}
                onClick={() => setActiveTab(app.id)}
              >
                {app.name}
              </button>
            ))}
          </div>
        )}

        {/* Content area */}
        {removedFromRoom ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Lock className="h-8 w-8" />
            <span className="text-sm">You are no longer a member of this room.</span>
          </div>
        ) : activeTab === 'chat' ? (
          <>
            {(pubError || e2eeInitError) && (
              <div className="px-5 py-2 bg-destructive/20 text-destructive text-sm flex items-center gap-2">
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
          <div ref={appContainerRef} className="flex-1 overflow-hidden flex flex-col min-h-0" />
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
