import { useEffect, useRef, useState, useMemo } from 'react';
import type { ChatClient } from '../lib/chat-client';
import type { ChatMessage } from '../types';

function looksLikeCiphertext(text: string): boolean {
  if (!text || text.length < 24) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

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
      // History messages are normally plaintext even with e2eeEpoch.
      // Only attempt fallback decrypt when payload still looks like ciphertext.
      const shouldDecryptHistory = m.e2ee === undefined && m.e2eeEpoch !== undefined && looksLikeCiphertext(m.text);
      if (m.e2ee === undefined && !shouldDecryptHistory) continue;
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
        try {
          const result = await client.e2ee.decrypt(msg);
          if (cancelled) {
            attemptedKeysRef.current.delete(key);
            return;
          }
          if (result.status === 'decrypted') {
            results[key] = result.text;
          } else if (result.status === 'no_key') {
            attemptedKeysRef.current.delete(key);
          } else if (result.status === 'failed') {
            results[key] = '\u{1F512} Unable to decrypt this message';
          }
        } catch (err) {
          console.warn(`[E2EE] Decryption threw for message ${key}:`, err);
          attemptedKeysRef.current.delete(key);
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
