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
  replyButton: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    padding: '2px 8px',
    background: '#334155',
    border: '1px solid #475569',
    borderRadius: '4px',
    color: '#94a3b8',
    fontSize: '11px',
    cursor: 'pointer',
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

export const MessageList: React.FC<Props> = ({ messages, currentUser, memberStatusMap, replyCounts, onReplyClick }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

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
            onMouseLeave={() => setHoveredIndex(null)}
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
            {isHovered && !msg.threadId && onReplyClick && (
              <button
                style={styles.replyButton}
                onClick={() => onReplyClick(msg)}
              >
                Reply
              </button>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
