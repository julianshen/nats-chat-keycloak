import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';

const STATUS_COLORS: Record<string, string> = {
  online: '#22c55e',
  away: '#f59e0b',
  busy: '#ef4444',
  offline: '#64748b',
};

interface Props {
  messages: ChatMessage[];
  currentUser: string;
  /** Map of userId → status (online, away, busy, offline) */
  memberStatusMap?: Record<string, string>;
  replyCounts?: Record<string, number>;
  onReplyClick?: (message: ChatMessage) => void;
  /** Callback to fetch read receipts on demand. Returns readers whose lastRead >= given timestamp. */
  onReadByClick?: (msg: ChatMessage) => Promise<Array<{userId: string; lastRead: number}>>;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  messageHoverArea: {
    position: 'relative' as const,
    padding: '6px 0',
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-start',
  },
  avatarWrapper: {
    position: 'relative' as const,
    flexShrink: 0,
  },
  avatar: {
    width: '32px',
    height: '32px',
    borderRadius: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: '14px',
    color: '#fff',
    flexShrink: 0,
  },
  statusDot: {
    position: 'absolute' as const,
    bottom: '-2px',
    right: '-2px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: '2px solid #0f172a',
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    marginBottom: '2px',
  },
  username: {
    fontWeight: 700,
    fontSize: '14px',
  },
  time: {
    fontSize: '11px',
    color: '#64748b',
  },
  text: {
    fontSize: '14px',
    color: '#cbd5e1',
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: '15px',
  },
  replyBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginTop: '4px',
    padding: '2px 8px',
    background: 'transparent',
    border: 'none',
    color: '#3b82f6',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: 600,
  },
  hoverActions: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    display: 'flex',
    gap: '2px',
  },
  hoverButton: {
    padding: '2px 8px',
    background: '#334155',
    border: '1px solid #475569',
    borderRadius: '4px',
    color: '#94a3b8',
    fontSize: '11px',
    cursor: 'pointer',
  },
  readByPopup: {
    position: 'absolute' as const,
    top: '28px',
    right: '4px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    padding: '8px 12px',
    zIndex: 10,
    minWidth: '120px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  readByTitle: {
    fontSize: '11px',
    color: '#64748b',
    marginBottom: '4px',
    fontWeight: 600,
  },
  readByUser: {
    fontSize: '12px',
    color: '#cbd5e1',
    padding: '2px 0',
  },
  readByEmpty: {
    fontSize: '12px',
    color: '#475569',
    fontStyle: 'italic' as const,
  },
};

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4'];

function getColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const MessageList: React.FC<Props> = ({ messages, currentUser, memberStatusMap, replyCounts, onReplyClick, onReadByClick }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [readByIndex, setReadByIndex] = useState<number | null>(null);
  const [readByUsers, setReadByUsers] = useState<Array<{userId: string; lastRead: number}>>([]);
  const [readByLoading, setReadByLoading] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return <div style={styles.empty}>No messages yet. Say something!</div>;
  }

  return (
    <div style={styles.container}>
      {messages.map((msg, i) => {
        const color = getColor(msg.user);
        const isOwn = msg.user === currentUser;
        const userStatus = memberStatusMap?.[msg.user];
        const dotColor = userStatus ? STATUS_COLORS[userStatus] || STATUS_COLORS.offline : undefined;
        const threadId = `${msg.room}-${msg.timestamp}`;
        const replyCount = (replyCounts?.[threadId] || 0) + (msg.replyCount || 0);
        const isHovered = hoveredIndex === i;
        return (
          <div
            key={`${msg.timestamp}-${i}`}
            style={styles.messageHoverArea}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => { setHoveredIndex(null); setReadByIndex(null); setReadByUsers([]); }}
          >
            <div style={styles.avatarWrapper}>
              <div style={{ ...styles.avatar, background: color }}>
                {msg.user.charAt(0).toUpperCase()}
              </div>
              {dotColor && <span style={{ ...styles.statusDot, backgroundColor: dotColor }} />}
            </div>
            <div style={styles.content}>
              <div style={styles.header}>
                <span style={{ ...styles.username, color: isOwn ? '#60a5fa' : color }}>
                  {msg.user}
                </span>
                <span style={styles.time}>{formatTime(msg.timestamp)}</span>
              </div>
              <div style={styles.text}>{msg.text}</div>
              {replyCount > 0 && (
                <button
                  style={styles.replyBadge}
                  onClick={() => onReplyClick?.(msg)}
                >
                  {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                </button>
              )}
            </div>
            {isHovered && (
              <div style={styles.hoverActions}>
                {!msg.threadId && onReplyClick && (
                  <button
                    style={styles.hoverButton}
                    onClick={() => onReplyClick(msg)}
                  >
                    Reply
                  </button>
                )}
                {onReadByClick && (
                  <button
                    style={styles.hoverButton}
                    onClick={async () => {
                      if (readByIndex === i) {
                        setReadByIndex(null);
                        setReadByUsers([]);
                        return;
                      }
                      setReadByIndex(i);
                      setReadByLoading(true);
                      const receipts = await onReadByClick(msg);
                      const readers = receipts.filter(
                        (r) => r.userId !== msg.user && r.lastRead >= msg.timestamp
                      );
                      setReadByUsers(readers);
                      setReadByLoading(false);
                    }}
                  >
                    Read by
                  </button>
                )}
              </div>
            )}
            {readByIndex === i && (
              <div style={styles.readByPopup}>
                <div style={styles.readByTitle}>Read by</div>
                {readByLoading ? (
                  <div style={styles.readByEmpty}>Loading...</div>
                ) : readByUsers.length === 0 ? (
                  <div style={styles.readByEmpty}>No one yet</div>
                ) : (
                  readByUsers.map((r) => (
                    <div key={r.userId} style={styles.readByUser}>{r.userId}</div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
