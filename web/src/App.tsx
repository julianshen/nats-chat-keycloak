import React, { useState, useCallback, useEffect } from 'react';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { NatsProvider, useNats } from './providers/NatsProvider';
import { MessageProvider, useMessages } from './providers/MessageProvider';
import { Header } from './components/Header';
import { RoomSelector } from './components/RoomSelector';
import { ChatRoom } from './components/ChatRoom';

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

const ChatContent: React.FC = () => {
  const { connected } = useNats();
  const { joinRoom } = useMessages();
  const [rooms, setRooms] = useState(DEFAULT_ROOMS);
  const [activeRoom, setActiveRoom] = useState('general');
  const [initialJoinDone, setInitialJoinDone] = useState(false);

  // Join all default rooms once connected
  useEffect(() => {
    if (!connected || initialJoinDone) return;
    DEFAULT_ROOMS.forEach((room) => joinRoom(room));
    setInitialJoinDone(true);
  }, [connected, joinRoom, initialJoinDone]);

  const handleAddRoom = useCallback((room: string) => {
    setRooms((prev) => [...prev, room]);
    setActiveRoom(room);
    // joinRoom is called by ChatRoom when it mounts
  }, []);

  return (
    <div style={styles.app}>
      <Header />
      <div style={styles.main}>
        <RoomSelector
          rooms={rooms}
          activeRoom={activeRoom}
          onSelectRoom={setActiveRoom}
          onAddRoom={handleAddRoom}
        />
        <ChatRoom key={activeRoom} room={activeRoom} />
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
