import { useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { ChatClient, type ChatClientConfig } from '../lib/chat-client';

const ChatClientContext = createContext<ChatClient | null>(null);

export const useChatClient = () => useContext(ChatClientContext);

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

  return (
    <ChatClientContext.Provider value={client}>
      {children}
    </ChatClientContext.Provider>
  );
};
