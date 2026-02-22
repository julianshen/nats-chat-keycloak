import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNats } from '../providers/NatsProvider';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';
import type { PresenceMember } from '../providers/MessageProvider';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { ThreadPanel } from './ThreadPanel';
import type { ChatMessage, HistoryResponse } from '../types';
import { tracedHeaders } from '../utils/tracing';
import { createAppBridge, destroyAppBridge } from '../lib/AppBridge';

interface Props {
  room: string;
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
};

// Map room name to NATS subject for publishing
function roomToSubject(room: string): string {
  if (room === '__admin__') return 'admin.chat';
  return `chat.${room}`;
}

export const ChatRoom: React.FC<Props> = ({ room }) => {
  const { nc, connected, error: natsError, sc } = useNats();
  const { userInfo } = useAuth();
  const { getMessages, joinRoom, markAsRead, onlineUsers, replyCounts, activeThread, openThread, closeThread, fetchReadReceipts, messageUpdates, translationResults, clearTranslation, translationAvailable, markTranslationUnavailable } = useMessages();
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [pubError, setPubError] = useState<string | null>(null);
  const [unreadAfterTs, setUnreadAfterTs] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [translatingKeys, setTranslatingKeys] = useState<Set<string>>(new Set());
  const [installedApps, setInstalledApps] = useState<Array<{id: string, name: string, componentUrl: string}>>([]);
  const [activeTab, setActiveTab] = useState<string>('chat');
  const appContainerRef = useRef<HTMLDivElement>(null);

  const subject = roomToSubject(room);

  // Join room and fetch history on mount
  useEffect(() => {
    if (!nc || !connected) return;

    setHistoryMessages([]);
    setPubError(null);
    setUnreadAfterTs(null);
    setHasMore(true);
    setLoadingMore(false);

    // Join the room via fanout-service and mark as read
    joinRoom(room);
    markAsRead(room);

    // Fetch user's own read position for the unread separator
    fetchReadReceipts(room).then((receipts) => {
      const own = receipts.find((r) => r.userId === userInfo?.username);
      if (own) setUnreadAfterTs(own.lastRead);
      else setUnreadAfterTs(0); // never read → all messages are unread
    });

    // Fetch history from history-service via NATS request/reply
    const historySubject = `chat.history.${room}`;
    const { headers: histHdr } = tracedHeaders();
    nc.request(historySubject, sc.encode(''), { timeout: 5000, headers: histHdr })
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
  }, [nc, connected, subject, sc, room, joinRoom, markAsRead, fetchReadReceipts, userInfo]);

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
  }, [nc, connected, loadingMore, hasMore, historyMessages, room, sc]);

  // Combine history messages with live messages from fan-out delivery
  const liveMessages = getMessages(room);
  const allMessages = React.useMemo(() => {
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
    if (allMessages.length === 0) return;
    const latestTs = allMessages[allMessages.length - 1].timestamp;
    markAsRead(room, latestTs);
  }, [allMessages, room, markAsRead]);

  // Publish a message (still publishes to chat.{room} — fanout-service handles delivery)
  const handleSend = useCallback(
    (text: string, mentions?: string[]) => {
      if (!nc || !connected || !userInfo) return;

      const msg: ChatMessage = {
        user: userInfo.username,
        text,
        timestamp: Date.now(),
        room,
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
      };

      try {
        const { headers: sendHdr } = tracedHeaders();
        nc.publish(subject, sc.encode(JSON.stringify(msg)), { headers: sendHdr });
        setPubError(null);
      } catch (err: any) {
        console.error('[NATS] Publish error:', err);
        setPubError(err.message || 'Failed to send message');
      }
    },
    [nc, connected, userInfo, room, subject, sc],
  );

  const handleEdit = useCallback((message: ChatMessage, newText: string) => {
    if (!nc || !connected || !userInfo) return;
    const editMsg = {
      user: userInfo.username,
      text: newText,
      timestamp: message.timestamp,
      room,
      action: 'edit' as const,
    };
    const { headers: editHdr } = tracedHeaders();
    nc.publish(subject, sc.encode(JSON.stringify(editMsg)), { headers: editHdr });
  }, [nc, connected, userInfo, room, subject, sc]);

  const handleDelete = useCallback((message: ChatMessage) => {
    if (!nc || !connected || !userInfo) return;
    const deleteMsg = {
      user: userInfo.username,
      text: '',
      timestamp: message.timestamp,
      room,
      action: 'delete' as const,
    };
    const { headers: delHdr } = tracedHeaders();
    nc.publish(subject, sc.encode(JSON.stringify(deleteMsg)), { headers: delHdr });
  }, [nc, connected, userInfo, room, subject, sc]);

  const handleReact = useCallback((message: ChatMessage, emoji: string) => {
    if (!nc || !connected || !userInfo) return;
    const reactMsg = {
      user: userInfo.username,
      text: '',
      timestamp: message.timestamp,
      room,
      action: 'react' as const,
      emoji,
      targetUser: message.user,
    };
    const { headers: reactHdr } = tracedHeaders();
    nc.publish(subject, sc.encode(JSON.stringify(reactMsg)), { headers: reactHdr });
  }, [nc, connected, userInfo, room, subject, sc]);

  const handleReplyClick = useCallback((message: ChatMessage) => {
    openThread(room, message);
  }, [room, openThread]);

  const handleReadByClick = useCallback(async (_msg: ChatMessage) => {
    return fetchReadReceipts(room);
  }, [room, fetchReadReceipts]);

  const handleSendSticker = useCallback(
    (stickerUrl: string) => {
      if (!nc || !connected || !userInfo) return;

      const msg: ChatMessage = {
        user: userInfo.username,
        text: '',
        timestamp: Date.now(),
        room,
        stickerUrl,
      };

      try {
        const { headers: sendHdr } = tracedHeaders();
        nc.publish(subject, sc.encode(JSON.stringify(msg)), { headers: sendHdr });
        setPubError(null);
      } catch (err: any) {
        console.error('[NATS] Publish sticker error:', err);
        setPubError(err.message || 'Failed to send sticker');
      }
    },
    [nc, connected, userInfo, room, subject, sc],
  );

  const handleTranslate = useCallback((message: ChatMessage, targetLang: string) => {
    if (!nc || !connected || !userInfo) return;
    const key = `${message.timestamp}-${message.user}`;
    clearTranslation(key);
    setTranslatingKeys(prev => new Set(prev).add(key));
    try {
      const { headers: hdr } = tracedHeaders();
      const req = JSON.stringify({ text: message.text, targetLang, user: userInfo.username, msgKey: key });
      nc.publish('translate.request', sc.encode(req), { headers: hdr });
    } catch (err) {
      console.error('[Translate] Publish failed:', err);
      setTranslatingKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [nc, connected, userInfo, sc]);

  // Clear translatingKeys only when streaming is complete (done: true)
  useEffect(() => {
    setTranslatingKeys(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const key of prev) {
        if (translationResults[key]?.done) {
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
        if (!translationResults[key]?.done) {
          markTranslationUnavailable();
          setTranslatingKeys(new Set());
          break;
        }
      }
    }, 15_000);
    return () => clearTimeout(timer);
  }, [translatingKeys, translationResults, markTranslationUnavailable]);

  const isDm = room.startsWith('dm-');

  // Fetch installed apps for this room (skip DM rooms)
  useEffect(() => {
    if (!nc || !connected || isDm) return;
    nc.request(`apps.room.${room}`, sc.encode(''), { timeout: 3000 })
      .then((reply) => {
        try {
          const apps = JSON.parse(sc.decode(reply.data));
          setInstalledApps(apps.map((a: any) => ({ id: a.id, name: a.name, componentUrl: a.componentUrl })));
        } catch (e) {
          console.error('[Apps] Failed to parse room apps:', e);
        }
      })
      .catch(() => { setInstalledApps([]); });
    setActiveTab('chat');
  }, [nc, connected, room, isDm, sc]);

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
  }, [activeTab, installedApps, nc, sc, room, userInfo]);
  const displayRoom = isDm
    ? (() => {
        const parts = room.replace('dm-', '').split('-');
        const other = parts.find((u) => u !== userInfo?.username) || parts[1];
        return other;
      })()
    : room === '__admin__' ? 'admin-channel' : room;
  const roomMembers: PresenceMember[] = onlineUsers[room] || [];
  const onlineCount = roomMembers.filter((m) => m.status !== 'offline').length;

  // Build a status map for MessageList
  const statusMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of roomMembers) {
      map[m.userId] = m.status;
    }
    return map;
  }, [roomMembers]);

  return (
    <div style={styles.outerContainer}>
      <div style={styles.innerContainer}>
        <div style={styles.roomHeader}>
          <div style={styles.roomName}>{isDm ? '@ ' : '# '}{displayRoom}</div>
          <div style={styles.roomSubject}>subject: {subject}</div>
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
        {activeTab === 'chat' ? (
          <>
            {(natsError || pubError) && (
              <div style={styles.errorBanner}>
                {natsError || pubError}
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
              onTranslate={translationAvailable ? handleTranslate : undefined}
              translations={translationResults}
              translatingKeys={translatingKeys}
              unreadAfterTs={effectiveUnreadAfterTs}
              onLoadMore={loadMore}
              hasMore={hasMore}
              loadingMore={loadingMore}
            />
            <MessageInput onSend={handleSend} onSendSticker={handleSendSticker} disabled={!connected} room={displayRoom} nc={nc} sc={sc} connected={connected} />
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
