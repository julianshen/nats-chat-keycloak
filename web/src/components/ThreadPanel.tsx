import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useChatClient } from '../hooks/useNatsChat';
import { useAuth } from '../providers/AuthProvider';
import { useThreadMessages } from '../hooks/useMessages';
import { useE2EE } from '../hooks/useE2EE';
import { MessageList } from './MessageList';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { X, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '../types';
import { renderMarkdown } from '../utils/markdown';

interface Props {
  room: string;
  threadId: string;
  parentMessage: ChatMessage;
  onClose: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const ThreadPanel: React.FC<Props> = ({ room, threadId, parentMessage, onClose }) => {
  const client = useChatClient();
  const connected = client?.isConnected ?? false;
  const { userInfo } = useAuth();
  const allReplies = useThreadMessages(client, threadId);
  const { isRoomEncrypted } = useE2EE(client);
  const [text, setText] = useState('');
  const [broadcast, setBroadcast] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const e2eeEnabled = isRoomEncrypted(room);

  // Fetch thread history on mount
  useEffect(() => {
    if (!client || !connected) return;
    client.messages.fetchThreadHistory(threadId).catch(() => {
      console.log('[Thread] Thread history request failed');
    });
  }, [client, connected, room, threadId]);

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
    <div className="w-[400px] border-l border-border flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-bold text-foreground">Thread</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Parent message */}
      <div className="px-4 py-3 border-b border-border bg-card">
        <div className="font-bold text-sm text-foreground mb-1">{parentMessage.user}</div>
        <div className="text-sm text-foreground/85 leading-relaxed break-words">{renderMarkdown(parentMessage.text, userInfo?.username || '')}</div>
        <div className="text-[11px] text-muted-foreground mt-1">{formatTime(parentMessage.timestamp)}</div>
      </div>

      {sendError && (
        <div className="px-4 py-2 bg-destructive/20 text-destructive text-sm">
          {sendError}
        </div>
      )}

      {/* Replies */}
      <div className="flex-1 overflow-y-auto">
        <MessageList
          messages={decryptedReplies}
          currentUser={userInfo?.username || ''}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onReact={handleReact}
        />
      </div>

      {/* Reply input */}
      <div className="px-4 py-3 border-t border-border bg-card">
        <form className="flex flex-col gap-2" onSubmit={handleSend}>
          <div className="flex gap-2">
            <Input
              className="h-9 text-sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Reply in thread..."
              disabled={!connected}
              autoFocus
            />
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-1.5"
              disabled={!connected || !text.trim()}
            >
              <Send className="h-3.5 w-3.5" />
              Reply
            </Button>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={broadcast}
              onChange={(e) => setBroadcast(e.target.checked)}
              className="rounded border-border"
            />
            Also send to #{room}
          </label>
        </form>
      </div>
    </div>
  );
};
