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
  const isConnectingRef = useRef(false);

  useEffect(() => {
    if (!config) {
      setClient(null);
      return;
    }

    const c = new ChatClient(config);
    clientRef.current = c;
    setClient(c);
    isConnectingRef.current = true;
    c.connect().catch(() => {
      // Retry loop handles subsequent attempts.
    }).finally(() => {
      if (clientRef.current === c) {
        isConnectingRef.current = false;
      }
    });

    return () => {
      if (clientRef.current === c) {
        c.disconnect();
        clientRef.current = null;
        isConnectingRef.current = false;
        setClient(null);
      }
    };
  }, [config?.token, config?.wsUrl, config?.username]);

  // Recover from transient initial connect failures (e.g. restart windows) by retrying.
  useEffect(() => {
    if (!client) return;
    const id = setInterval(() => {
      if (!shouldRetryConnect(client) || isConnectingRef.current) return;
      isConnectingRef.current = true;
      void client.connect()
        .catch(() => {
          // ConnectionManager emits detailed errors; keep retry loop quiet.
        })
        .finally(() => {
          if (clientRef.current === client) {
            isConnectingRef.current = false;
          }
        });
    }, 3000);
    return () => clearInterval(id);
  }, [client]);

  return (
    <ChatClientContext.Provider value={client}>
      {children}
    </ChatClientContext.Provider>
  );
};
