import React, { useState } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useMessages } from '../providers/MessageProvider';

interface Props {
  rooms: string[];
  activeRoom: string;
  onSelectRoom: (room: string) => void;
  onAddRoom: (room: string) => void;
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
};

export const RoomSelector: React.FC<Props> = ({ rooms, activeRoom, onSelectRoom, onAddRoom }) => {
  const [newRoom, setNewRoom] = useState('');
  const { userInfo } = useAuth();
  const { unreadCounts } = useMessages();
  const isAdmin = userInfo?.roles.includes('admin') ?? false;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newRoom.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (name && !rooms.includes(name)) {
      onAddRoom(name);
      setNewRoom('');
    }
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
            {unreadCounts[room] > 0 && (
              <span style={styles.unreadBadge}>
                {unreadCounts[room] > 99 ? '99+' : unreadCounts[room]}
              </span>
            )}
          </div>
        ))}
      </div>
      {isAdmin && (
        <div style={styles.adminSection}>
          <div style={styles.adminBadge}>🛡️ Admin Channel</div>
          <div
            style={{
              ...styles.adminRoom,
              ...(activeRoom === '__admin__' ? { fontWeight: 700 } : {}),
            }}
            onClick={() => onSelectRoom('__admin__')}
          >
            <span style={{ ...styles.hash, color: '#f59e0b' }}>#</span>
            admin-channel
            {unreadCounts['__admin__'] > 0 && (
              <span style={{ ...styles.unreadBadge, background: '#f59e0b' }}>
                {unreadCounts['__admin__'] > 99 ? '99+' : unreadCounts['__admin__']}
              </span>
            )}
          </div>
        </div>
      )}
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
