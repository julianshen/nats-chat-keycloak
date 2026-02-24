import React, { useState, useCallback, useEffect } from 'react';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { NatsProvider, useNats } from './providers/NatsProvider';
import { MessageProvider, useMessages } from './providers/MessageProvider';
import { Header } from './components/Header';
import { RoomSelector } from './components/RoomSelector';
import { ChatRoom } from './components/ChatRoom';
import type { RoomInfo } from './types';

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
  const { nc, connected, sc } = useNats();
  const { userInfo } = useAuth();
  const { joinRoom, unreadCounts } = useMessages();
  const [rooms, setRooms] = useState(DEFAULT_ROOMS);
  const [activeRoom, setActiveRoom] = useState('general');
  const [initialJoinDone, setInitialJoinDone] = useState(false);
  const [dmRooms, setDmRooms] = useState<string[]>(loadDmRooms);
  const [privateRooms, setPrivateRooms] = useState<RoomInfo[]>([]);

  // Join all default rooms once connected
  useEffect(() => {
    if (!connected || initialJoinDone) return;
    DEFAULT_ROOMS.forEach((room) => joinRoom(room));
    setInitialJoinDone(true);
  }, [connected, joinRoom, initialJoinDone]);

  // Fetch private rooms on connect
  useEffect(() => {
    if (!nc || !connected || !userInfo || !initialJoinDone) return;

    nc.request('room.list', sc.encode(JSON.stringify({ user: userInfo.username })), { timeout: 5000 })
      .then((reply) => {
        try {
          const rooms = JSON.parse(sc.decode(reply.data)) as RoomInfo[];
          setPrivateRooms(rooms);
          // Join all private rooms the user belongs to
          rooms.forEach((r) => joinRoom(r.name));
        } catch {
          console.log('[Room] Failed to parse room list');
        }
      })
      .catch((err) => {
        console.log('[Room] Room list request failed:', err);
      });
  }, [nc, connected, userInfo, initialJoinDone, sc, joinRoom]);

  // Discover DM rooms from database on connect, then re-join all known DMs
  useEffect(() => {
    if (!nc || !connected || !userInfo || !initialJoinDone) return;

    // Query history-service for DM rooms this user participates in
    nc.request('chat.dms', sc.encode(userInfo.username), { timeout: 5000 })
      .then((reply) => {
        try {
          const serverDms = JSON.parse(sc.decode(reply.data)) as string[];
          if (serverDms.length > 0) {
            setDmRooms((prev) => {
              const merged = [...prev];
              for (const dm of serverDms) {
                if (!merged.includes(dm)) merged.push(dm);
              }
              return merged.length !== prev.length ? merged : prev;
            });
          }
        } catch {
          console.log('[DM] Failed to parse DM discovery response');
        }
      })
      .catch((err) => {
        console.log('[DM] DM discovery request failed:', err);
      });
  }, [nc, connected, userInfo, initialJoinDone, sc]);

  // Re-join all known DM rooms whenever the list changes (re-establishes fanout membership)
  const dmRoomsJoinedRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!nc || !connected || !userInfo) return;
    dmRooms.forEach((dmRoom) => {
      if (dmRoomsJoinedRef.current.has(dmRoom)) return;
      dmRoomsJoinedRef.current.add(dmRoom);
      const parts = dmRoom.replace('dm-', '').split('-');
      const otherUser = parts.find((u) => u !== userInfo.username) || parts[1];
      const payload1 = JSON.stringify({ userId: userInfo.username });
      const payload2 = JSON.stringify({ userId: otherUser });
      nc.publish(`room.join.${dmRoom}`, sc.encode(payload1));
      nc.publish(`room.join.${dmRoom}`, sc.encode(payload2));
    });
  }, [nc, connected, userInfo, sc, dmRooms]);

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

  const handleAddRoom = useCallback((room: string) => {
    setRooms((prev) => [...prev, room]);
    setActiveRoom(room);
  }, []);

  const handleCreateRoom = useCallback((name: string, displayName: string) => {
    if (!nc || !connected || !userInfo) return;
    nc.request('room.create', sc.encode(JSON.stringify({ name, displayName, user: userInfo.username })), { timeout: 5000 })
      .then((reply) => {
        try {
          const r = JSON.parse(sc.decode(reply.data)) as RoomInfo;
          if ((r as any).error) {
            console.error('[Room] Create failed:', (r as any).error);
            return;
          }
          setPrivateRooms((prev) => [...prev, r]);
          setActiveRoom(r.name);
        } catch {
          console.error('[Room] Failed to parse create response');
        }
      })
      .catch((err) => {
        console.error('[Room] Create request failed:', err);
      });
  }, [nc, connected, userInfo, sc]);

  const handleRoomRemoved = useCallback((roomName: string) => {
    setPrivateRooms((prev) => prev.filter((c) => c.name !== roomName));
    setActiveRoom((current) => (current === roomName ? 'general' : current));
  }, []);

  // Auto-discover private rooms from incoming messages for unknown rooms
  useEffect(() => {
    const knownRooms = new Set([...rooms, ...dmRooms, ...privateRooms.map((c) => c.name), '__admin__']);
    const newPrivateRooms = Object.keys(unreadCounts).filter(
      (key) => !key.startsWith('dm-') && !knownRooms.has(key)
    );
    if (newPrivateRooms.length > 0 && nc && connected && userInfo) {
      // Check if these are private rooms the user was just invited to
      newPrivateRooms.forEach((room) => {
        nc.request(`room.info.${room}`, sc.encode(''), { timeout: 3000 })
          .then((reply) => {
            try {
              const r = JSON.parse(sc.decode(reply.data)) as RoomInfo;
              if (r.type === 'private' && !(r as any).error) {
                setPrivateRooms((prev) => {
                  if (prev.some((c) => c.name === r.name)) return prev;
                  return [...prev, r];
                });
                joinRoom(r.name);
              }
            } catch { /* ignore */ }
          })
          .catch(() => { /* not a private room */ });
      });
    }
  }, [unreadCounts, rooms, dmRooms, privateRooms, nc, connected, userInfo, sc, joinRoom]);

  const handleStartDm = useCallback((otherUser: string) => {
    if (!nc || !connected || !userInfo) return;
    // Compute canonical DM room key (sorted usernames)
    const sorted = [userInfo.username, otherUser].sort();
    const dmKey = `dm-${sorted[0]}-${sorted[1]}`;

    // Join for both users so fanout-service delivers to both
    const payload1 = JSON.stringify({ userId: userInfo.username });
    const payload2 = JSON.stringify({ userId: otherUser });
    nc.publish(`room.join.${dmKey}`, sc.encode(payload1));
    nc.publish(`room.join.${dmKey}`, sc.encode(payload2));

    // Add to DM rooms if not already present
    setDmRooms((prev) => (prev.includes(dmKey) ? prev : [...prev, dmKey]));
    setActiveRoom(dmKey);
  }, [nc, connected, userInfo, sc]);

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
  const { loading, error, authenticated } = useAuth();

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
    <NatsProvider>
      <MessageProvider>
        <ChatContent />
      </MessageProvider>
    </NatsProvider>
  );
};

const App: React.FC = () => (
  <AuthProvider>
    <ChatApp />
  </AuthProvider>
);

export default App;
