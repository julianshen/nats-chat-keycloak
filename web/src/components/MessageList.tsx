import React, { useEffect, useRef } from 'react';
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
  message: {
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

export const MessageList: React.FC<Props> = ({ messages, currentUser, memberStatusMap }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

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
        return (
          <div key={`${msg.timestamp}-${i}`} style={styles.message}>
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
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
