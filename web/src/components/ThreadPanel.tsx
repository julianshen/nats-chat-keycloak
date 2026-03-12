import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNats } from '../providers/NatsProvider';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';
import { useE2EE } from '../providers/E2EEProvider';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../types';
import { tracedHeaders, startActionSpan, tracedHeadersWithContext } from '../utils/tracing';
import { renderMarkdown } from '../utils/markdown';

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
  const { isE2EE, encrypt, decrypt } = useE2EE();
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [broadcast, setBroadcast] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const e2eeEnabled = isE2EE(room);

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

  // Decrypt live E2EE thread replies client-side
  const [decryptedTexts, setDecryptedTexts] = useState<Record<string, string>>({});
  const attemptedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!e2eeEnabled) return;
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
        const result = await decrypt(msg);
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
  }, [allReplies, e2eeEnabled, decrypt]);

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

  // Build the ingest subject for thread replies: deliver.{userId}.send.{room}.thread.{threadId}
  const threadSubject = userInfo ? `deliver.${userInfo.username}.send.${room}.thread.${threadId}` : '';

  // Edit a thread reply
  const handleEdit = useCallback(async (message: ChatMessage, newText: string) => {
    if (!nc || !connected || !userInfo) return;
    const action = startActionSpan('edit_thread_message', { 'chat.room': room, 'chat.user': userInfo.username, 'chat.action': 'thread_edit' });
    try {
      let editText = newText;
      let e2eeField: { epoch: number; v: number } | undefined;
      if (e2eeEnabled) {
        const encrypted = await encrypt(room, userInfo.username, message.timestamp, newText);
        if (encrypted) {
          editText = encrypted.ciphertext;
          e2eeField = { epoch: encrypted.epoch, v: 1 };
        } else {
          setSendError('Encryption failed — edit not sent. Room key may be missing.');
          action.end(new Error('E2EE encryption failed'));
          return;
        }
      }
      const editMsg = {
        user: userInfo.username,
        text: editText,
        timestamp: message.timestamp,
        room,
        threadId,
        action: 'edit' as const,
        ...(e2eeField ? { e2ee: e2eeField } : {}),
      };
      const { headers: editHdr } = tracedHeadersWithContext(action.ctx, 'chat.thread.publish.edit');
      nc.publish(threadSubject, sc.encode(JSON.stringify(editMsg)), { headers: editHdr });
      action.end();
    } catch (err) {
      action.end(err instanceof Error ? err : new Error(String(err)));
    }
  }, [nc, connected, userInfo, room, threadId, threadSubject, sc, e2eeEnabled, encrypt]);

  // React to a thread reply
  const handleReact = useCallback((message: ChatMessage, emoji: string) => {
    if (!nc || !connected || !userInfo) return;
    const action = startActionSpan('react_thread_message', { 'chat.room': room, 'chat.user': userInfo.username, 'chat.action': 'thread_react' });
    try {
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
      const { headers: reactHdr } = tracedHeadersWithContext(action.ctx, 'chat.thread.publish.react');
      nc.publish(threadSubject, sc.encode(JSON.stringify(reactMsg)), { headers: reactHdr });
      action.end();
    } catch (err) {
      action.end(err instanceof Error ? err : new Error(String(err)));
    }
  }, [nc, connected, userInfo, room, threadId, threadSubject, sc]);

  // Delete a thread reply
  const handleDelete = useCallback((message: ChatMessage) => {
    if (!nc || !connected || !userInfo) return;
    const action = startActionSpan('delete_thread_message', { 'chat.room': room, 'chat.user': userInfo.username, 'chat.action': 'thread_delete' });
    try {
      const deleteMsg = {
        user: userInfo.username,
        text: '',
        timestamp: message.timestamp,
        room,
        threadId,
        action: 'delete' as const,
      };
      const { headers: delHdr } = tracedHeadersWithContext(action.ctx, 'chat.thread.publish.delete');
      nc.publish(threadSubject, sc.encode(JSON.stringify(deleteMsg)), { headers: delHdr });
      action.end();
    } catch (err) {
      action.end(err instanceof Error ? err : new Error(String(err)));
    }
  }, [nc, connected, userInfo, room, threadId, threadSubject, sc]);

  // Send thread reply
  const handleSend = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !nc || !connected || !userInfo) return;

    // Extract mentions from text
    const mentionMatches = trimmed.match(/@(\w[\w-]*)/g);
    const mentions = mentionMatches ? [...new Set(mentionMatches.map((m) => m.slice(1)))] : undefined;

    const timestamp = Date.now();
    let msgText = trimmed;
    let e2eeField: { epoch: number; v: number } | undefined;

    if (e2eeEnabled) {
      const encrypted = await encrypt(room, userInfo.username, timestamp, trimmed);
      if (encrypted) {
        msgText = encrypted.ciphertext;
        e2eeField = { epoch: encrypted.epoch, v: 1 };
      } else {
        setSendError('Encryption failed — reply not sent. Room key may be missing.');
        return;
      }
    }

    const msg: ChatMessage = {
      user: userInfo.username,
      text: msgText,
      timestamp,
      room,
      threadId,
      parentTimestamp: parentMessage.timestamp,
      broadcast,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
      ...(e2eeField ? { e2ee: e2eeField } : {}),
    };

    const action = startActionSpan('send_thread_reply', { 'chat.room': room, 'chat.user': userInfo.username, 'chat.action': 'thread_reply' });
    try {
      const { headers: replyHdr } = tracedHeadersWithContext(action.ctx, 'chat.thread.publish');
      nc.publish(threadSubject, sc.encode(JSON.stringify(msg)), { headers: replyHdr });
      setSendError(null);

      // If broadcast, also publish to main room timeline via ingest path
      if (broadcast) {
        const roomSubject = `deliver.${userInfo.username}.send.${room}`;
        const { headers: broadcastHdr } = tracedHeadersWithContext(action.ctx, 'chat.thread.broadcast');
        nc.publish(roomSubject, sc.encode(JSON.stringify(msg)), { headers: broadcastHdr });
      }

      action.end();
      setText('');
    } catch (err) {
      setSendError('Failed to send reply. Please try again.');
      action.end(err instanceof Error ? err : new Error(String(err)));
    }
  }, [nc, connected, userInfo, text, room, threadId, threadSubject, parentMessage.timestamp, broadcast, sc, e2eeEnabled, encrypt]);

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
