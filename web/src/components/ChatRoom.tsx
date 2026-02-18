import React, { useEffect, useState, useCallback } from 'react';
import { useNats } from '../providers/NatsProvider';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import type { ChatMessage } from '../types';

interface Props {
  room: string;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
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
  greenDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: '#22c55e',
    flexShrink: 0,
  },
  memberPill: {
    fontSize: '11px',
    color: '#cbd5e1',
    background: '#1e293b',
    borderRadius: '10px',
    padding: '1px 8px',
    whiteSpace: 'nowrap' as const,
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
};

// Map room name to NATS subject for publishing
function roomToSubject(room: string): string {
  if (room === '__admin__') return 'admin.chat';
  return `chat.${room}`;
}

export const ChatRoom: React.FC<Props> = ({ room }) => {
  const { nc, connected, error: natsError, sc } = useNats();
  const { userInfo } = useAuth();
  const { getMessages, joinRoom, markAsRead, onlineUsers } = useMessages();
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [pubError, setPubError] = useState<string | null>(null);

  const subject = roomToSubject(room);

  // Join room and fetch history on mount
  useEffect(() => {
    if (!nc || !connected) return;

    setHistoryMessages([]);
    setPubError(null);

    // Join the room via fanout-service and mark as read
    joinRoom(room);
    markAsRead(room);

    // Fetch history from history-service via NATS request/reply
    const historySubject = `chat.history.${room}`;
    nc.request(historySubject, sc.encode(''), { timeout: 5000 })
      .then((reply) => {
        try {
          const history = JSON.parse(sc.decode(reply.data)) as ChatMessage[];
          if (history.length > 0) {
            setHistoryMessages(history);
          }
        } catch {
          console.log('[NATS] Failed to parse history response');
        }
      })
      .catch((err) => {
        console.log('[NATS] History request failed (service may not be running):', err);
      });
  }, [nc, connected, subject, sc, room, joinRoom, markAsRead]);

  // Combine history messages with live messages from fan-out delivery
  const liveMessages = getMessages(room);
  const allMessages = React.useMemo(() => {
    if (historyMessages.length === 0) return liveMessages;
    if (liveMessages.length === 0) return historyMessages;

    // Find where live messages start (after the last history message)
    const lastHistoryTs = historyMessages[historyMessages.length - 1]?.timestamp || 0;
    const newLiveMessages = liveMessages.filter((m) => m.timestamp > lastHistoryTs);
    return [...historyMessages, ...newLiveMessages];
  }, [historyMessages, liveMessages]);

  // Publish a message (still publishes to chat.{room} — fanout-service handles delivery)
  const handleSend = useCallback(
    (text: string) => {
      if (!nc || !connected || !userInfo) return;

      const msg: ChatMessage = {
        user: userInfo.username,
        text,
        timestamp: Date.now(),
        room,
      };

      try {
        nc.publish(subject, sc.encode(JSON.stringify(msg)));
        setPubError(null);
      } catch (err: any) {
        console.error('[NATS] Publish error:', err);
        setPubError(err.message || 'Failed to send message');
      }
    },
    [nc, connected, userInfo, room, subject, sc],
  );

  const displayRoom = room === '__admin__' ? 'admin-channel' : room;

  return (
    <div style={styles.container}>
      <div style={styles.roomHeader}>
        <div style={styles.roomName}># {displayRoom}</div>
        <div style={styles.roomSubject}>subject: {subject}</div>
        {(onlineUsers[room]?.length ?? 0) > 0 && (
          <div style={styles.presenceBar}>
            <span style={styles.presenceIndicator}>
              <span style={styles.greenDot} />
              {onlineUsers[room].length} online
            </span>
            {onlineUsers[room].map((user) => (
              <span key={user} style={styles.memberPill}>{user}</span>
            ))}
          </div>
        )}
      </div>
      {(natsError || pubError) && (
        <div style={styles.errorBanner}>
          {natsError || pubError}
        </div>
      )}
      <MessageList messages={allMessages} currentUser={userInfo?.username || ''} onlineMembers={onlineUsers[room]} />
      <MessageInput onSend={handleSend} disabled={!connected} room={displayRoom} />
    </div>
  );
};
