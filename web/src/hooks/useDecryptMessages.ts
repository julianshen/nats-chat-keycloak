import { useEffect, useRef, useState, useMemo } from 'react';
import type { ChatClient } from '../lib/chat-client';
import type { ChatMessage } from '../types';

/**
 * Decrypt E2EE messages client-side.
 * Returns the messages with decrypted text substituted in.
 */
export function useDecryptMessages(
  messages: ChatMessage[],
  e2eeEnabled: boolean,
  client: ChatClient | null,
  resetKey?: string, // pass room or threadId to reset cache on change
): ChatMessage[] {
  const [decryptedTexts, setDecryptedTexts] = useState<Record<string, string>>({});
  const attemptedKeysRef = useRef<Set<string>>(new Set());

  // Clear cache when resetKey changes
  useEffect(() => {
    setDecryptedTexts({});
    attemptedKeysRef.current.clear();
  }, [resetKey]);

  // Decrypt pending messages
  useEffect(() => {
    if (!e2eeEnabled || !client) return;
    let cancelled = false;
    const pending: Array<{ key: string; msg: ChatMessage }> = [];
    for (const m of messages) {
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
  }, [messages, e2eeEnabled, client]);

  // Apply decrypted texts
  return useMemo(() => {
    if (Object.keys(decryptedTexts).length === 0) return messages;
    return messages.map(m => {
      const key = `${m.room}-${m.timestamp}-${m.user}`;
      const decrypted = decryptedTexts[key];
      if (decrypted !== undefined) return { ...m, text: decrypted };
      return m;
    });
  }, [messages, decryptedTexts]);
}
