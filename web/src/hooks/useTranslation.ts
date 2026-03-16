import { useState, useEffect } from 'react';
import type { ChatClient } from '../lib/chat-client';

export function useTranslation(client: ChatClient | null) {
  const [available, setAvailable] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!client) return;
    setAvailable(client.translation.isAvailable);

    const unsubs = [
      client.translation.on('availabilityChanged', (avail) => setAvailable(avail)),
      client.translation.on('result', (msgKey, text, _done) => {
        setResults(prev => ({ ...prev, [msgKey]: text }));
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [client]);

  return {
    available,
    results,
    request: (text: string, lang: string, key: string) => client?.requestTranslation(text, lang, key),
    clearResult: (key: string) => setResults(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    }),
  };
}
