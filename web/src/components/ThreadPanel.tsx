import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useChatClient } from '../hooks/useNatsChat';
import { useAuth } from '../providers/AuthProvider';
import { useThreadMessages } from '../hooks/useMessages';
import { useE2EE } from '../hooks/useE2EE';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../types';
import { tracedHeaders } from '../utils/tracing';
import { renderMarkdown } from '../utils/markdown';
import { sc } from '../lib/chat-client';

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
  const client = useChatClient();
  const nc = client?.connection.nc ?? null;
  const connected = client?.isConnected ?? false;
  const { userInfo } = useAuth();
  const liveMessages = useThreadMessages(client, threadId);
  const { isRoomEncrypted } = useE2EE(client);
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [broadcast, setBroadcast] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const e2eeEnabled = isRoomEncrypted(room);

  // Fetch thread history on mount
  // TODO: Replace with ChatClient method when thread history is added to ChatClient
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
  }, [nc, connected, room, threadId]);

  // Combine history with live thread messages
  const allReplies = React.useMemo(() => {
    if (historyMessages.length === 0) return liveMessages;
    if (liveMessages.length === 0) return historyMessages;

    const lastHistoryTs = historyMessages[historyMessages.length - 1]?.timestamp || 0;
    const newLiveMessages = liveMessages.filter((m) => m.timestamp > lastHistoryTs);
    return [...historyMessages, ...newLiveMessages];
  }, [historyMessages, liveMessages]);

  // Decrypt live E2EE thread replies client-side
  const [decryptedTexts, setDecryptedTexts] = useState<Record<string, string>>({});
  const attemptedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!e2eeEnabled || !client) return;
    let cancelled = false;
    const pending: Array<{ key: string; msg: ChatMessage }> = [];
    for (const m of allReplies) {
      if (!m.e2ee && !m.e2eeEpoch) continue;
      const key = `${m.room}-${m.timestamp}-${m.user}`;
      if (attemptedKeysRef.current.has(key)) continue;
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
          attemptedKeysRef.current.delete(key);
        } else if (result.status === 'failed') {
          results[key] = '\u{1F512} Unable to decrypt this message';
        }
      }
      if (!cancelled && Object.keys(results).length > 0) {
        setDecryptedTexts(prev => ({ ...prev, ...results }));
      }
    })();
    return () => { cancelled = true; };
  }, [allReplies, e2eeEnabled, client]);

  // Apply decrypted texts to thread replies
  const decryptedReplies = React.useMemo(() => {
    if (Object.keys(decryptedTexts).length === 0) return allReplies;
    return allReplies.map(m => {
      const key = `${m.room}-${m.timestamp}-${m.user}`;
      const decrypted = decryptedTexts[key];
      if (decrypted !== undefined) return { ...m, text: decrypted };
      return m;
    });
  }, [allReplies, decryptedTexts]);

  // Clear decrypted texts cache when thread changes
  useEffect(() => {
    setDecryptedTexts({});
    attemptedKeysRef.current.clear();
  }, [room, threadId]);

  // Edit a thread reply
  const handleEdit = useCallback(async (message: ChatMessage, newText: string) => {
    if (!client || !connected || !userInfo) return;
    await client.editThreadMessage(room, threadId, message.timestamp, message.user, newText);
  }, [client, connected, userInfo, room, threadId]);

  // React to a thread reply
  const handleReact = useCallback((message: ChatMessage, emoji: string) => {
    if (!client || !connected || !userInfo) return;
    client.reactToThreadMessage(room, threadId, message.timestamp, message.user, emoji);
  }, [client, connected, userInfo, room, threadId]);

  // Delete a thread reply
  const handleDelete = useCallback((message: ChatMessage) => {
    if (!client || !connected || !userInfo) return;
    client.deleteThreadMessage(room, threadId, message.timestamp);
  }, [client, connected, userInfo, room, threadId]);

  // Send thread reply
  const handleSend = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !client || !connected || !userInfo) return;

    // Extract mentions from text
    const mentionMatches = trimmed.match(/@(\w[\w-]*)/g);
    const mentions = mentionMatches ? [...new Set(mentionMatches.map((m) => m.slice(1)))] : undefined;

    try {
      await client.sendThreadReply(room, threadId, trimmed, { mentions, broadcast });
      setSendError(null);
      setText('');
    } catch (err) {
      setSendError('Failed to send reply. Please try again.');
    }
  }, [client, connected, userInfo, text, room, threadId, broadcast]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Thread</span>
        <button style={styles.closeBtn} onClick={onClose}>X</button>
      </div>
      <div style={styles.parentSection}>
        <div style={styles.parentUser}>{parentMessage.user}</div>
        <div style={styles.parentText}>{renderMarkdown(parentMessage.text, userInfo?.username || '')}</div>
        <div style={styles.parentTime}>{formatTime(parentMessage.timestamp)}</div>
      </div>
      {sendError && (
        <div style={{ padding: '8px 16px', background: '#7f1d1d', color: '#fca5a5', fontSize: '13px' }}>
          {sendError}
        </div>
      )}
      <div style={styles.repliesSection}>
        <MessageList
          messages={decryptedReplies}
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
