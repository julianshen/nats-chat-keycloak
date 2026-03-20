import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { ChatClientProvider, useChatClient } from './hooks/useNatsChat';
import { useAllUnreads } from './hooks/useMessages';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Header } from './components/Header';
import { RoomSelector } from './components/RoomSelector';
import { ChatRoom } from './components/ChatRoom';
import type { RoomInfo } from './types';
import type { ChatClientConfig } from './lib/chat-client';
import { sc } from './lib/chat-client';
import { loadPrivateRooms, savePrivateRooms } from './lib/privateRoomsCache';
import { dmOtherUser } from './utils/chat-utils';
import { Button } from '@/components/ui/button';
import { ThemeProvider } from './providers/ThemeProvider';

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
  const [connected, setConnected] = useState(false);
  const { userInfo } = useAuth();
  const { unreadCounts } = useAllUnreads(client);
  const [rooms, setRooms] = useState(DEFAULT_ROOMS);
  const [activeRoom, setActiveRoom] = useState('general');
  const [initialJoinDone, setInitialJoinDone] = useState(false);
  const [dmRooms, setDmRooms] = useState<string[]>(loadDmRooms);
  const [privateRooms, setPrivateRooms] = useState<RoomInfo[]>(loadPrivateRooms);
  const pendingPrivateJoinsRef = useRef<Set<string>>(new Set());
  const joinedPrivateRoomsRef = useRef<Set<string>>(new Set());
  const privateJoinTimerRef = useRef<number | null>(null);
  const clientRef = useRef(client);
  const connectedRef = useRef(connected);

  const schedulePrivateRoomJoins = useCallback(() => {
    if (!clientRef.current || !connectedRef.current) return;
    if (privateJoinTimerRef.current !== null) return;

    const runBatch = () => {
      privateJoinTimerRef.current = null;
      const liveClient = clientRef.current;
      if (!liveClient || !connectedRef.current) return;

      const pending = pendingPrivateJoinsRef.current;
      if (pending.size === 0) return;

      const batch = Array.from(pending).slice(0, 50);
      batch.forEach((name) => pending.delete(name));
      batch.forEach((name) => {
        liveClient.joinRoom(name);
        joinedPrivateRoomsRef.current.add(name);
      });

      if (pending.size > 0) {
        privateJoinTimerRef.current = window.setTimeout(runBatch, 0);
      }
    };

    privateJoinTimerRef.current = window.setTimeout(runBatch, 0);
  }, []);

  const queuePrivateRoomJoins = useCallback((names: string[]) => {
    if (names.length === 0) return;
    names.forEach((name) => pendingPrivateJoinsRef.current.add(name));
    schedulePrivateRoomJoins();
  }, [schedulePrivateRoomJoins]);

  useEffect(() => () => {
    if (privateJoinTimerRef.current !== null) {
      window.clearTimeout(privateJoinTimerRef.current);
      privateJoinTimerRef.current = null;
    }
    pendingPrivateJoinsRef.current.clear();
    joinedPrivateRoomsRef.current.clear();
  }, []);

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  useEffect(() => {
    connectedRef.current = connected;
    if (!connected && privateJoinTimerRef.current !== null) {
      window.clearTimeout(privateJoinTimerRef.current);
      privateJoinTimerRef.current = null;
    }
  }, [connected]);

  // Keep UI connection state in sync with ChatClient connection events.
  useEffect(() => {
    if (!client) {
      setConnected(false);
      pendingPrivateJoinsRef.current.clear();
      joinedPrivateRoomsRef.current.clear();
      if (privateJoinTimerRef.current !== null) {
        window.clearTimeout(privateJoinTimerRef.current);
        privateJoinTimerRef.current = null;
      }
      return;
    }

    setConnected(client.isConnected);
    const offConnected = client.on('connected', () => setConnected(true));
    const offDisconnected = client.on('disconnected', () => setConnected(false));

    return () => {
      offConnected();
      offDisconnected();
    };
  }, [client]);

  // Join all default rooms once connected
  useEffect(() => {
    if (!client || !connected || initialJoinDone) return;
    DEFAULT_ROOMS.forEach((room) => client.joinRoom(room));
    setInitialJoinDone(true);
  }, [client, connected, initialJoinDone]);

  // Re-join any cached private rooms immediately after reconnect/refresh
  useEffect(() => {
    if (!client || !connected || !userInfo || !initialJoinDone) return;
    const toEnqueue = privateRooms
      .map((r) => r.name)
      .filter((name) => !joinedPrivateRoomsRef.current.has(name) && !pendingPrivateJoinsRef.current.has(name));
    queuePrivateRoomJoins(toEnqueue);
  }, [client, connected, userInfo, initialJoinDone, privateRooms, queuePrivateRoomJoins]);

  // Fetch private rooms on connect
  useEffect(() => {
    if (!client || !connected || !userInfo || !initialJoinDone) return;

    client.listRooms()
      .then((rooms) => {
        try {
          const roomList = rooms as RoomInfo[];
          setPrivateRooms(roomList);
        } catch {
          console.log('[Room] Failed to parse room list');
        }
      })
      .catch((err) => {
        console.log('[Room] Room list request failed:', err);
      });
  }, [client, connected, userInfo, initialJoinDone, queuePrivateRoomJoins]);

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
      const otherUser = dmOtherUser(dmRoom, userInfo.username);
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
    pendingPrivateJoinsRef.current.delete(roomName);
    joinedPrivateRoomsRef.current.delete(roomName);
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
        } catch (err) {
          console.warn(`[Room] Failed to check room info for ${roomName}:`, err);
        }
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
    <div className="h-screen flex flex-col">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <RoomSelector
          rooms={rooms}
          activeRoom={activeRoom}
          onSelectRoom={setActiveRoom}
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
      <div className="h-screen flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="h-10 w-10 rounded-full border-[3px] border-muted border-t-primary animate-spin" />
        Authenticating with Keycloak...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 text-destructive p-5 text-center">
        <div className="text-5xl">&#128274;</div>
        <div className="text-lg font-semibold">Authentication Error</div>
        <div className="text-muted-foreground text-sm">{error}</div>
        <Button onClick={() => window.location.reload()} variant="default" className="mt-2">
          Retry
        </Button>
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
  <ThemeProvider>
    <AuthProvider>
      <TooltipProvider>
        <ChatApp />
      </TooltipProvider>
    </AuthProvider>
  </ThemeProvider>
);

export default App;
