import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { ChatClientProvider, useChatClient } from './hooks/useNatsChat';
import { useAllUnreads } from './hooks/useMessages';
import { Header } from './components/Header';
import { RoomSelector } from './components/RoomSelector';
import { ChatRoom } from './components/ChatRoom';
import type { RoomInfo } from './types';
import type { ChatClientConfig } from './lib/chat-client';
import { sc } from './lib/chat-client';
import { loadPrivateRooms, savePrivateRooms } from './lib/privateRoomsCache';

const styles: Record<string, React.CSSProperties> = {
  app: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  loading: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    color: '#94a3b8',
    fontSize: '16px',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '3px solid #334155',
    borderTop: '3px solid #3b82f6',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  error: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    color: '#fca5a5',
    fontSize: '16px',
    padding: '20px',
    textAlign: 'center',
  },
};

const DEFAULT_ROOMS = ['general', 'random', 'help'];

const DM_STORAGE_KEY = 'dm-rooms';

function loadDmRooms(): string[] {
  try {
    const stored = localStorage.getItem(DM_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

const ChatContent: React.FC = () => {
  const client = useChatClient();
  const connected = client?.isConnected ?? false;
  const { userInfo } = useAuth();
  const { unreadCounts } = useAllUnreads(client);
  const [rooms, setRooms] = useState(DEFAULT_ROOMS);
  const [activeRoom, setActiveRoom] = useState('general');
  const [initialJoinDone, setInitialJoinDone] = useState(false);
  const [dmRooms, setDmRooms] = useState<string[]>(loadDmRooms);
  const [privateRooms, setPrivateRooms] = useState<RoomInfo[]>(loadPrivateRooms);

  // Join all default rooms once connected
  useEffect(() => {
    if (!client || !connected || initialJoinDone) return;
    DEFAULT_ROOMS.forEach((room) => client.joinRoom(room));
    setInitialJoinDone(true);
  }, [client, connected, initialJoinDone]);

  // Re-join any cached private rooms immediately after reconnect/refresh
  useEffect(() => {
    if (!client || !connected || !userInfo || !initialJoinDone) return;
    privateRooms.forEach((r) => client.joinRoom(r.name));
  }, [client, connected, userInfo, initialJoinDone, privateRooms]);

  // Fetch private rooms on connect
  useEffect(() => {
    if (!client || !connected || !userInfo || !initialJoinDone) return;

    client.listRooms()
      .then((rooms) => {
        try {
          const roomList = rooms as RoomInfo[];
          setPrivateRooms(roomList);
          // Join all private rooms the user belongs to
          roomList.forEach((r) => client.joinRoom(r.name));
        } catch {
          console.log('[Room] Failed to parse room list');
        }
      })
      .catch((err) => {
        console.log('[Room] Room list request failed:', err);
      });
  }, [client, connected, userInfo, initialJoinDone]);

  // Discover DM rooms from database on connect, then re-join all known DMs
  useEffect(() => {
    if (!client || !connected || !userInfo || !initialJoinDone) return;

    client.listDMs()
      .then((serverDms) => {
        if (serverDms.length > 0) {
          setDmRooms((prev) => {
            const merged = [...prev];
            for (const dm of serverDms) {
              if (!merged.includes(dm)) merged.push(dm);
            }
            return merged.length !== prev.length ? merged : prev;
          });
        }
      })
      .catch((err) => {
        console.log('[DM] DM discovery request failed:', err);
      });
  }, [client, connected, userInfo, initialJoinDone]);

  // Re-join all known DM rooms whenever the list changes (re-establishes fanout membership)
  const dmRoomsJoinedRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!client || !connected || !userInfo) return;
    const nc = client.connection.nc;
    if (!nc) return;
    dmRooms.forEach((dmRoom) => {
      if (dmRoomsJoinedRef.current.has(dmRoom)) return;
      dmRoomsJoinedRef.current.add(dmRoom);
      const parts = dmRoom.replace('dm-', '').split('-');
      const otherUser = parts.find((u) => u !== userInfo.username) || parts[1];
      const payload1 = JSON.stringify({ userId: userInfo.username });
      const payload2 = JSON.stringify({ userId: otherUser });
      // TODO: Replace with ChatClient method when DM room join is added
      nc.publish(`room.join.${dmRoom}`, sc.encode(payload1));
      nc.publish(`room.join.${dmRoom}`, sc.encode(payload2));
    });
  }, [client, connected, userInfo, dmRooms]);

  // Auto-discover new DMs from incoming messages (unread counts with dm- prefix)
  useEffect(() => {
    const newDms = Object.keys(unreadCounts).filter(
      (key) => key.startsWith('dm-') && !dmRooms.includes(key)
    );
    if (newDms.length > 0) {
      setDmRooms((prev) => [...prev, ...newDms]);
    }
  }, [unreadCounts, dmRooms]);

  // Persist DM rooms to localStorage
  useEffect(() => {
    localStorage.setItem(DM_STORAGE_KEY, JSON.stringify(dmRooms));
  }, [dmRooms]);

  // Persist private rooms to localStorage so refresh can render instantly
  useEffect(() => {
    savePrivateRooms(privateRooms);
  }, [privateRooms]);

  const handleAddRoom = useCallback((room: string) => {
    setRooms((prev) => [...prev, room]);
    setActiveRoom(room);
  }, []);

  const handleCreateRoom = useCallback(async (name: string, displayName: string) => {
    if (!client || !connected || !userInfo) return;
    try {
      const r = await client.createRoom(name, displayName);
      if (r && !(r as any).error) {
        setPrivateRooms((prev) => [...prev, r as RoomInfo]);
        setActiveRoom((r as RoomInfo).name);
      } else if (r) {
        console.error('[Room] Create failed:', (r as any).error);
      }
    } catch (err) {
      console.error('[Room] Create request failed:', err);
    }
  }, [client, connected, userInfo]);

  const handleRoomRemoved = useCallback((roomName: string) => {
    setPrivateRooms((prev) => prev.filter((c) => c.name !== roomName));
    setActiveRoom((current) => (current === roomName ? 'general' : current));
  }, []);

  // Auto-discover private rooms from incoming messages for unknown rooms
  useEffect(() => {
    if (!client || !connected || !userInfo) return;
    const knownRooms = new Set([...rooms, ...dmRooms, ...privateRooms.map((c) => c.name), '__admin__']);
    const newPrivateRooms = Object.keys(unreadCounts).filter(
      (key) => !key.startsWith('dm-') && !knownRooms.has(key)
    );
    if (newPrivateRooms.length > 0) {
      // Check if these are private rooms the user was just invited to
      newPrivateRooms.forEach(async (roomName) => {
        try {
          const r = await client.getRoomInfo(roomName);
          if (r && r.type === 'private' && !(r as any).error) {
            setPrivateRooms((prev) => {
              if (prev.some((c) => c.name === r.name)) return prev;
              return [...prev, r as RoomInfo];
            });
            client.joinRoom(r.name);
          }
        } catch { /* not a private room */ }
      });
    }
  }, [unreadCounts, rooms, dmRooms, privateRooms, client, connected, userInfo]);

  const handleStartDm = useCallback((otherUser: string) => {
    if (!client || !connected || !userInfo) return;
    const nc = client.connection.nc;
    if (!nc) return;
    // Compute canonical DM room key (sorted usernames)
    const sorted = [userInfo.username, otherUser].sort();
    const dmKey = `dm-${sorted[0]}-${sorted[1]}`;

    // Join for both users so fanout-service delivers to both
    // TODO: Replace with ChatClient method when DM room join is added
    const payload1 = JSON.stringify({ userId: userInfo.username });
    const payload2 = JSON.stringify({ userId: otherUser });
    nc.publish(`room.join.${dmKey}`, sc.encode(payload1));
    nc.publish(`room.join.${dmKey}`, sc.encode(payload2));

    // Add to DM rooms if not already present
    setDmRooms((prev) => (prev.includes(dmKey) ? prev : [...prev, dmKey]));
    setActiveRoom(dmKey);
  }, [client, connected, userInfo]);

  return (
    <div style={styles.app}>
      <Header />
      <div style={styles.main}>
        <RoomSelector
          rooms={rooms}
          activeRoom={activeRoom}
          onSelectRoom={setActiveRoom}
          onAddRoom={handleAddRoom}
          dmRooms={dmRooms}
          onStartDm={handleStartDm}
          privateRooms={privateRooms}
          onCreateRoom={handleCreateRoom}
        />
        <ChatRoom key={activeRoom} room={activeRoom} isPrivateRoom={privateRooms.some((c) => c.name === activeRoom)} onRoomRemoved={handleRoomRemoved} />
      </div>
    </div>
  );
};

const ChatApp: React.FC = () => {
  const { loading, error, authenticated, token, userInfo } = useAuth();

  const config = useMemo<ChatClientConfig | null>(() => {
    if (!authenticated || !token || !userInfo) return null;
    const wsUrl = (window as any).__env__?.VITE_NATS_WS_URL
      || import.meta.env.VITE_NATS_WS_URL
      || `ws://${window.location.hostname}:9222`;
    return {
      token,
      wsUrl,
      username: userInfo.username,
    };
  }, [authenticated, token, userInfo]);

  if (loading) {
    return (
      <div style={styles.loading}>
        <div style={styles.spinner} />
        Authenticating with Keycloak...
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.error}>
        <div style={{ fontSize: '48px' }}>&#128274;</div>
        <div>Authentication Error</div>
        <div style={{ color: '#94a3b8', fontSize: '14px' }}>{error}</div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 20px',
            background: '#3b82f6',
            border: 'none',
            borderRadius: '6px',
            color: '#fff',
            cursor: 'pointer',
            marginTop: '8px',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <ChatClientProvider config={config}>
      <ChatContent />
    </ChatClientProvider>
  );
};

const App: React.FC = () => (
  <AuthProvider>
    <ChatApp />
  </AuthProvider>
);

export default App;
