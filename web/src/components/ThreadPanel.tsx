import React, { useEffect, useState, useCallback } from 'react';
import { useNats } from '../providers/NatsProvider';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../types';

interface Props {
  room: string;
  threadId: string;
  parentMessage: ChatMessage;
  onClose: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '400px',
    borderLeft: '1px solid #334155',
    display: 'flex',
    flexDirection: 'column',
    background: '#0f172a',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #1e293b',
    background: '#0f172a',
  },
  headerTitle: {
    fontSize: '15px',
    fontWeight: 700,
    color: '#f1f5f9',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
  },
  parentSection: {
    padding: '12px 16px',
    borderBottom: '1px solid #1e293b',
    background: '#1e293b',
  },
  parentUser: {
    fontWeight: 700,
    fontSize: '13px',
    color: '#e2e8f0',
    marginBottom: '4px',
  },
  parentText: {
    fontSize: '14px',
    color: '#cbd5e1',
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  parentTime: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '4px',
  },
  repliesSection: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  inputArea: {
    padding: '12px 16px',
    borderTop: '1px solid #334155',
    background: '#1e293b',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '6px',
    color: '#e2e8f0',
    fontSize: '13px',
    outline: 'none',
  },
  sendBtn: {
    padding: '8px 16px',
    background: '#3b82f6',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    fontWeight: 600,
    fontSize: '13px',
    cursor: 'pointer',
  },
  disabledBtn: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  broadcastRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: '#94a3b8',
  },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const ThreadPanel: React.FC<Props> = ({ room, threadId, parentMessage, onClose }) => {
  const { nc, connected, sc } = useNats();
  const { userInfo } = useAuth();
  const { getThreadMessages } = useMessages();
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [broadcast, setBroadcast] = useState(false);

  // Fetch thread history on mount
  useEffect(() => {
    if (!nc || !connected) return;

    const historySubject = `chat.history.${room}.thread.${threadId}`;
    nc.request(historySubject, sc.encode(''), { timeout: 5000 })
      .then((reply) => {
        try {
          const history = JSON.parse(sc.decode(reply.data)) as ChatMessage[];
          if (history.length > 0) {
            setHistoryMessages(history);
          }
        } catch {
          console.log('[Thread] Failed to parse thread history');
        }
      })
      .catch((err) => {
        console.log('[Thread] Thread history request failed:', err);
      });
  }, [nc, connected, sc, room, threadId]);

  // Combine history with live thread messages
  const liveMessages = getThreadMessages(threadId);
  const allReplies = React.useMemo(() => {
    if (historyMessages.length === 0) return liveMessages;
    if (liveMessages.length === 0) return historyMessages;

    const lastHistoryTs = historyMessages[historyMessages.length - 1]?.timestamp || 0;
    const newLiveMessages = liveMessages.filter((m) => m.timestamp > lastHistoryTs);
    return [...historyMessages, ...newLiveMessages];
  }, [historyMessages, liveMessages]);

  // Send thread reply
  const handleSend = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !nc || !connected || !userInfo) return;

    const msg: ChatMessage = {
      user: userInfo.username,
      text: trimmed,
      timestamp: Date.now(),
      room,
      threadId,
      parentTimestamp: parentMessage.timestamp,
      broadcast,
    };

    const threadSubject = `chat.${room}.thread.${threadId}`;
    nc.publish(threadSubject, sc.encode(JSON.stringify(msg)));

    // If broadcast, also publish to main room timeline
    if (broadcast) {
      const roomSubject = `chat.${room}`;
      nc.publish(roomSubject, sc.encode(JSON.stringify(msg)));
    }

    setText('');
  }, [nc, connected, userInfo, text, room, threadId, parentMessage.timestamp, broadcast, sc]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Thread</span>
        <button style={styles.closeBtn} onClick={onClose}>X</button>
      </div>
      <div style={styles.parentSection}>
        <div style={styles.parentUser}>{parentMessage.user}</div>
        <div style={styles.parentText}>{parentMessage.text}</div>
        <div style={styles.parentTime}>{formatTime(parentMessage.timestamp)}</div>
      </div>
      <div style={styles.repliesSection}>
        <MessageList
          messages={allReplies}
          currentUser={userInfo?.username || ''}
        />
      </div>
      <div style={styles.inputArea}>
        <form style={styles.form} onSubmit={handleSend}>
          <div style={styles.inputRow}>
            <input
              style={styles.input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Reply in thread..."
              disabled={!connected}
              autoFocus
            />
            <button
              type="submit"
              style={{
                ...styles.sendBtn,
                ...(!connected || !text.trim() ? styles.disabledBtn : {}),
              }}
              disabled={!connected || !text.trim()}
            >
              Reply
            </button>
          </div>
          <label style={styles.broadcastRow}>
            <input
              type="checkbox"
              checked={broadcast}
              onChange={(e) => setBroadcast(e.target.checked)}
            />
            Also send to #{room}
          </label>
        </form>
      </div>
    </div>
  );
};
