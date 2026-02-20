import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useNats } from '../providers/NatsProvider';
import { useMessages } from '../providers/MessageProvider';
import type { UserSearchResult } from '../types';

interface Props {
  rooms: string[];
  activeRoom: string;
  onSelectRoom: (room: string) => void;
  onAddRoom: (room: string) => void;
  dmRooms: string[];
  onStartDm: (user: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '220px',
    background: '#1e293b',
    borderRight: '1px solid #334155',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  heading: {
    padding: '16px',
    fontSize: '12px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: '#64748b',
  },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px',
    fontSize: '12px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: '#64748b',
  },
  addDmButton: {
    background: 'none',
    border: '1px solid #475569',
    borderRadius: '4px',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: 1,
    width: '22px',
    height: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  roomList: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  roomItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '14px',
    color: '#94a3b8',
    transition: 'background 0.15s',
  },
  active: {
    background: '#334155',
    color: '#f1f5f9',
  },
  hash: {
    fontSize: '16px',
    fontWeight: 700,
    color: '#475569',
  },
  addForm: {
    padding: '12px 16px',
    borderTop: '1px solid #334155',
  },
  addInput: {
    width: '100%',
    padding: '6px 10px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '4px',
    color: '#e2e8f0',
    fontSize: '13px',
    outline: 'none',
  },
  adminSection: {
    padding: '8px 16px',
    borderTop: '1px solid #334155',
  },
  adminBadge: {
    fontSize: '11px',
    color: '#f59e0b',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '4px',
  },
  adminRoom: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 0',
    cursor: 'pointer',
    fontSize: '14px',
    color: '#f59e0b',
  },
  mentionBadge: {
    minWidth: '20px',
    height: '20px',
    padding: '0 6px',
    borderRadius: '10px',
    background: '#ef4444',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
  unreadBadge: {
    marginLeft: 'auto',
    minWidth: '20px',
    height: '20px',
    padding: '0 6px',
    borderRadius: '10px',
    background: '#3b82f6',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
  dmSection: {
    borderTop: '1px solid #334155',
  },
  dmItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '14px',
    color: '#94a3b8',
    transition: 'background 0.15s',
  },
  atSymbol: {
    fontSize: '14px',
    fontWeight: 700,
    color: '#6366f1',
  },
  searchOverlay: {
    padding: '8px 16px',
    borderTop: '1px solid #334155',
  },
  searchInput: {
    width: '100%',
    padding: '6px 10px',
    background: '#0f172a',
    border: '1px solid #475569',
    borderRadius: '4px',
    color: '#e2e8f0',
    fontSize: '13px',
    outline: 'none',
    marginBottom: '4px',
  },
  searchResults: {
    maxHeight: '150px',
    overflowY: 'auto' as const,
  },
  searchResultItem: {
    padding: '6px 8px',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#cbd5e1',
    borderRadius: '4px',
    transition: 'background 0.15s',
  },
  searchResultName: {
    fontSize: '11px',
    color: '#64748b',
    marginLeft: '4px',
  },
  searchLoading: {
    padding: '6px 8px',
    fontSize: '12px',
    color: '#64748b',
  },
};

export const RoomSelector: React.FC<Props> = ({ rooms, activeRoom, onSelectRoom, onAddRoom, dmRooms, onStartDm }) => {
  const [newRoom, setNewRoom] = useState('');
  const { userInfo } = useAuth();
  const { nc, connected, sc } = useNats();
  const { unreadCounts, mentionCounts } = useMessages();
  const isAdmin = userInfo?.roles.includes('admin') ?? false;

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced user search via NATS request/reply
  useEffect(() => {
    if (!showSearch || !nc || !connected) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = searchQuery.trim();
    if (trimmed.length === 0) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const reply = await nc.request('users.search', sc.encode(trimmed), { timeout: 5000 });
        const results = JSON.parse(sc.decode(reply.data)) as UserSearchResult[];
        // Filter out current user
        setSearchResults(results.filter((u) => u.username !== userInfo?.username));
      } catch (err) {
        console.log('[UserSearch] Search failed:', err);
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, showSearch, nc, connected, sc, userInfo]);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newRoom.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (name && !rooms.includes(name)) {
      onAddRoom(name);
      setNewRoom('');
    }
  };

  const handleSelectUser = (username: string) => {
    onStartDm(username);
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleToggleSearch = () => {
    setShowSearch((prev) => !prev);
    if (showSearch) {
      setSearchQuery('');
      setSearchResults([]);
    }
  };

  // Extract the other user's name from a DM room key
  const dmDisplayName = (dmRoom: string): string => {
    const parts = dmRoom.replace('dm-', '').split('-');
    const other = parts.find((u) => u !== userInfo?.username) || parts[1];
    return other;
  };

  return (
    <div style={styles.sidebar}>
      <div style={styles.heading}>Rooms</div>
      <div style={styles.roomList}>
        {rooms.map((room) => (
          <div
            key={room}
            style={{
              ...styles.roomItem,
              ...(activeRoom === room ? styles.active : {}),
            }}
            onClick={() => onSelectRoom(room)}
          >
            <span style={styles.hash}>#</span>
            {room}
            {mentionCounts[room] > 0 && (
              <span style={{ ...styles.mentionBadge, marginLeft: unreadCounts[room] > 0 ? '0' : 'auto' }}>@{mentionCounts[room]}</span>
            )}
            {unreadCounts[room] > 0 && (
              <span style={{ ...styles.unreadBadge, marginLeft: mentionCounts[room] > 0 ? '4px' : 'auto' }}>
                {unreadCounts[room] > 99 ? '99+' : unreadCounts[room]}
              </span>
            )}
          </div>
        ))}
      </div>
      {isAdmin && (
        <div style={styles.adminSection}>
          <div style={styles.adminBadge}>Admin Channel</div>
          <div
            style={{
              ...styles.adminRoom,
              ...(activeRoom === '__admin__' ? { fontWeight: 700 } : {}),
            }}
            onClick={() => onSelectRoom('__admin__')}
          >
            <span style={{ ...styles.hash, color: '#f59e0b' }}>#</span>
            admin-channel
            {mentionCounts['__admin__'] > 0 && (
              <span style={{ ...styles.mentionBadge, marginLeft: unreadCounts['__admin__'] > 0 ? '0' : 'auto' }}>@{mentionCounts['__admin__']}</span>
            )}
            {unreadCounts['__admin__'] > 0 && (
              <span style={{ ...styles.unreadBadge, background: '#f59e0b', marginLeft: mentionCounts['__admin__'] > 0 ? '4px' : 'auto' }}>
                {unreadCounts['__admin__'] > 99 ? '99+' : unreadCounts['__admin__']}
              </span>
            )}
          </div>
        </div>
      )}
      <div style={styles.dmSection}>
        <div style={styles.headingRow}>
          <span>Direct Messages</span>
          <button
            style={styles.addDmButton}
            onClick={handleToggleSearch}
            title="New direct message"
          >
            {showSearch ? '\u00D7' : '+'}
          </button>
        </div>
        {showSearch && (
          <div style={styles.searchOverlay}>
            <input
              ref={searchInputRef}
              style={styles.searchInput}
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div style={styles.searchResults}>
              {searching && <div style={styles.searchLoading}>Searching...</div>}
              {!searching && searchResults.length === 0 && searchQuery.trim().length > 0 && (
                <div style={styles.searchLoading}>No users found</div>
              )}
              {searchResults.map((user) => (
                <div
                  key={user.username}
                  style={styles.searchResultItem}
                  onClick={() => handleSelectUser(user.username)}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#334155'; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
                >
                  <span style={styles.atSymbol}>@</span> {user.username}
                  {(user.firstName || user.lastName) && (
                    <span style={styles.searchResultName}>
                      ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {dmRooms.map((dmRoom) => (
          <div
            key={dmRoom}
            style={{
              ...styles.dmItem,
              ...(activeRoom === dmRoom ? styles.active : {}),
            }}
            onClick={() => onSelectRoom(dmRoom)}
          >
            <span style={styles.atSymbol}>@</span>
            {dmDisplayName(dmRoom)}
            {mentionCounts[dmRoom] > 0 && (
              <span style={{ ...styles.mentionBadge, marginLeft: unreadCounts[dmRoom] > 0 ? '0' : 'auto' }}>@{mentionCounts[dmRoom]}</span>
            )}
            {unreadCounts[dmRoom] > 0 && (
              <span style={{ ...styles.unreadBadge, marginLeft: mentionCounts[dmRoom] > 0 ? '4px' : 'auto' }}>
                {unreadCounts[dmRoom] > 99 ? '99+' : unreadCounts[dmRoom]}
              </span>
            )}
          </div>
        ))}
      </div>
      <form style={styles.addForm} onSubmit={handleSubmit}>
        <input
          style={styles.addInput}
          placeholder="Add room..."
          value={newRoom}
          onChange={(e) => setNewRoom(e.target.value)}
        />
      </form>
    </div>
  );
};
