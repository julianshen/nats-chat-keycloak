import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { connect, NatsConnection, StringCodec } from 'nats.ws';
import { useAuth } from './AuthProvider';

interface NatsContextType {
  nc: NatsConnection | null;
  connected: boolean;
  error: string | null;
  sc: ReturnType<typeof StringCodec>;
  /** Force a NATS reconnect (triggers new auth callout → fresh JWT with updated permissions) */
  reconnect: () => void;
}

const sc = StringCodec();

const NatsContext = createContext<NatsContextType>({
  nc: null,
  connected: false,
  error: null,
  sc,
  reconnect: () => {},
});

export const useNats = () => useContext(NatsContext);

const NATS_WS_URL = (window as any).__env__?.VITE_NATS_WS_URL || import.meta.env.VITE_NATS_WS_URL || 'ws://localhost:9222';

export const NatsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, authenticated, userInfo } = useAuth();
  const [nc, setNc] = useState<NatsConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ncRef = useRef<NatsConnection | null>(null);
  const connectingRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  const connectToNats = useCallback(async (authToken: string) => {
    if (connectingRef.current) return;
    connectingRef.current = true;

    // Close existing connection
    if (ncRef.current) {
      try {
        await ncRef.current.drain();
      } catch {
        // Ignore drain errors
      }
      ncRef.current = null;
      setNc(null);
      setConnected(false);
    }

    try {
      console.log('[NATS] Connecting to', NATS_WS_URL);
      const conn = await connect({
        servers: NATS_WS_URL,
        token: authToken,
        name: userInfo?.username || 'nats-chat-web',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      });

      ncRef.current = conn;
      setNc(conn);
      setConnected(true);
      setError(null);
      console.log('[NATS] Connected to', conn.getServer());

      // Monitor connection status — stop if this connection has been replaced
      (async () => {
        for await (const s of conn.status()) {
          if (ncRef.current !== conn) break;
          console.log(`[NATS] Status: ${s.type}`, s.data);
          switch (s.type) {
            case 'disconnect':
              setConnected(false);
              break;
            case 'reconnect':
              setConnected(true);
              break;
            case 'error':
              setError(`Connection error: ${s.data}`);
              break;
          }
        }
      })();

      // Handle connection close — only update state if this is still the active connection
      conn.closed().then(() => {
        console.log('[NATS] Connection closed');
        if (ncRef.current === conn) {
          setConnected(false);
          setNc(null);
          ncRef.current = null;
        }
      });
    } catch (err: any) {
      console.error('[NATS] Connection failed:', err);
      setError(`Failed to connect to NATS: ${err.message}`);
      setConnected(false);
    } finally {
      connectingRef.current = false;
    }
  }, []);

  // Force a NATS reconnect — used when membership changes require a fresh JWT.
  // Debounced: multiple signals within 1s trigger only one reconnect.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) return; // already scheduled
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const currentToken = tokenRef.current;
      if (currentToken) {
        console.log('[NATS] Reconnecting for updated permissions (membership changed)');
        connectToNats(currentToken);
      }
    }, 1000);
  }, [connectToNats]);

  // Connect when we have a token
  useEffect(() => {
    if (authenticated && token) {
      connectToNats(token);
    }

    return () => {
      if (ncRef.current) {
        ncRef.current.drain().catch(() => {});
      }
    };
  }, [authenticated, token, connectToNats]);

  return (
    <NatsContext.Provider value={{ nc, connected, error, sc, reconnect }}>
      {children}
    </NatsContext.Provider>
  );
};
