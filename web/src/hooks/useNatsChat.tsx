import { useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { ChatClient, type ChatClientConfig } from '../lib/chat-client';

const ChatClientContext = createContext<ChatClient | null>(null);

export const useChatClient = () => useContext(ChatClientContext);

export function shouldRetryConnect(client: ChatClient): boolean {
  return !client.isConnected && !client.connection.nc;
}

export const ChatClientProvider: React.FC<{
  config: ChatClientConfig | null;
  children: ReactNode;
}> = ({ config, children }) => {
  const [client, setClient] = useState<ChatClient | null>(null);
  const clientRef = useRef<ChatClient | null>(null);

  useEffect(() => {
    if (!config) {
      setClient(null);
      return;
    }

    const c = new ChatClient(config);
    clientRef.current = c;
    setClient(c);
    c.connect();

    return () => {
      if (clientRef.current === c) {
        c.disconnect();
        clientRef.current = null;
        setClient(null);
      }
    };
  }, [config?.token, config?.wsUrl, config?.username]);

  // Recover from transient initial connect failures (e.g. restart windows) by retrying.
  useEffect(() => {
    if (!client) return;
    const id = setInterval(() => {
      if (shouldRetryConnect(client)) {
        client.connect().catch(() => {
          // ConnectionManager emits detailed errors; keep retry loop quiet.
        });
      }
    }, 3000);
    return () => clearInterval(id);
  }, [client]);

  return (
    <ChatClientContext.Provider value={client}>
      {children}
    </ChatClientContext.Provider>
  );
};
