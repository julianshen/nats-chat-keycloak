import React from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useNats } from '../providers/NatsProvider';

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    background: '#1e293b',
    borderBottom: '1px solid #334155',
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  title: {
    fontSize: '18px',
    fontWeight: 700,
    color: '#f1f5f9',
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    color: '#94a3b8',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
  },
  username: {
    fontWeight: 600,
    color: '#e2e8f0',
  },
  role: {
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  logoutBtn: {
    padding: '6px 14px',
    background: '#334155',
    border: '1px solid #475569',
    borderRadius: '6px',
    color: '#e2e8f0',
    cursor: 'pointer',
    fontSize: '13px',
  },
};

export const Header: React.FC = () => {
  const { userInfo, logout } = useAuth();
  const { connected } = useNats();

  const roleColors: Record<string, string> = {
    admin: '#f59e0b',
    user: '#3b82f6',
  };

  return (
    <div style={styles.header}>
      <div style={styles.left}>
        <span style={styles.title}>💬 NATS Chat</span>
        <div style={styles.status}>
          <span style={{ ...styles.dot, background: connected ? '#22c55e' : '#ef4444' }} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>
      <div style={styles.right}>
        {userInfo && (
          <div style={styles.userInfo}>
            <span style={styles.username}>{userInfo.username}</span>
            {userInfo.roles.map((role) => (
              <span
                key={role}
                style={{
                  ...styles.role,
                  background: (roleColors[role] || '#64748b') + '22',
                  color: roleColors[role] || '#64748b',
                  border: `1px solid ${roleColors[role] || '#64748b'}44`,
                }}
              >
                {role}
              </span>
            ))}
          </div>
        )}
        <button style={styles.logoutBtn} onClick={logout}>
          Logout
        </button>
      </div>
    </div>
  );
};
