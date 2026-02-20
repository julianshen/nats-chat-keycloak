import React, { useEffect, useState, useCallback } from 'react';
import { useNats } from '../providers/NatsProvider';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../types';
import { tracedHeaders } from '../utils/tracing';

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
    const { headers: histHdr } = tracedHeaders();
    nc.request(historySubject, sc.encode(''), { timeout: 5000, headers: histHdr })
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

  // Edit a thread reply
  const handleEdit = useCallback((message: ChatMessage, newText: string) => {
    if (!nc || !connected || !userInfo) return;
    const editMsg = {
      user: userInfo.username,
      text: newText,
      timestamp: message.timestamp,
      room,
      threadId,
      action: 'edit' as const,
    };
    const threadSubject = `chat.${room}.thread.${threadId}`;
    const { headers: editHdr } = tracedHeaders();
    nc.publish(threadSubject, sc.encode(JSON.stringify(editMsg)), { headers: editHdr });
  }, [nc, connected, userInfo, room, threadId, sc]);

  // React to a thread reply
  const handleReact = useCallback((message: ChatMessage, emoji: string) => {
    if (!nc || !connected || !userInfo) return;
    const reactMsg = {
      user: userInfo.username,
      text: '',
      timestamp: message.timestamp,
      room,
      threadId,
      action: 'react' as const,
      emoji,
      targetUser: message.user,
    };
    const threadSubject = `chat.${room}.thread.${threadId}`;
    const { headers: reactHdr } = tracedHeaders();
    nc.publish(threadSubject, sc.encode(JSON.stringify(reactMsg)), { headers: reactHdr });
  }, [nc, connected, userInfo, room, threadId, sc]);

  // Delete a thread reply
  const handleDelete = useCallback((message: ChatMessage) => {
    if (!nc || !connected || !userInfo) return;
    const deleteMsg = {
      user: userInfo.username,
      text: '',
      timestamp: message.timestamp,
      room,
      threadId,
      action: 'delete' as const,
    };
    const threadSubject = `chat.${room}.thread.${threadId}`;
    const { headers: delHdr } = tracedHeaders();
    nc.publish(threadSubject, sc.encode(JSON.stringify(deleteMsg)), { headers: delHdr });
  }, [nc, connected, userInfo, room, threadId, sc]);

  // Send thread reply
  const handleSend = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !nc || !connected || !userInfo) return;

    // Extract mentions from text
    const mentionMatches = trimmed.match(/@(\w[\w-]*)/g);
    const mentions = mentionMatches ? [...new Set(mentionMatches.map((m) => m.slice(1)))] : undefined;

    const msg: ChatMessage = {
      user: userInfo.username,
      text: trimmed,
      timestamp: Date.now(),
      room,
      threadId,
      parentTimestamp: parentMessage.timestamp,
      broadcast,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    };

    const threadSubject = `chat.${room}.thread.${threadId}`;
    const { headers: replyHdr } = tracedHeaders();
    nc.publish(threadSubject, sc.encode(JSON.stringify(msg)), { headers: replyHdr });

    // If broadcast, also publish to main room timeline
    if (broadcast) {
      const roomSubject = `chat.${room}`;
      const { headers: broadcastHdr } = tracedHeaders();
      nc.publish(roomSubject, sc.encode(JSON.stringify(msg)), { headers: broadcastHdr });
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
          onEdit={handleEdit}
          onDelete={handleDelete}
          onReact={handleReact}
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
