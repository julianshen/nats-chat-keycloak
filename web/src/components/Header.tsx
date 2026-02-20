import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useNats } from '../providers/NatsProvider';
import { useMessages } from '../providers/MessageProvider';

const STATUS_OPTIONS = [
  { value: 'online', label: 'Online', color: '#22c55e' },
  { value: 'away', label: 'Away', color: '#f59e0b' },
  { value: 'busy', label: 'Busy', color: '#ef4444' },
  { value: 'offline', label: 'Offline', color: '#64748b' },
];

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
  statusSelector: {
    position: 'relative' as const,
    display: 'inline-flex',
  },
  statusButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    background: '#334155',
    border: '1px solid #475569',
    borderRadius: '6px',
    color: '#e2e8f0',
    cursor: 'pointer',
    fontSize: '12px',
  },
  statusDropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: '4px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    overflow: 'hidden',
    zIndex: 50,
    minWidth: '120px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  },
  statusOption: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#e2e8f0',
    border: 'none',
    background: 'transparent',
    width: '100%',
    textAlign: 'left' as const,
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
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
  const { setStatus, currentStatus, totalMentions } = useMessages();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentOption = STATUS_OPTIONS.find((o) => o.value === currentStatus) || STATUS_OPTIONS[0];

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [dropdownOpen]);

  const roleColors: Record<string, string> = {
    admin: '#f59e0b',
    user: '#3b82f6',
  };

  return (
    <div style={styles.header}>
      <div style={styles.left}>
        <span style={styles.title}>NATS Chat</span>
        {totalMentions > 0 && (
          <span style={{
            background: '#ef4444',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: '10px',
            lineHeight: 1,
          }}>@ {totalMentions}</span>
        )}
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
        {connected && (
          <div style={styles.statusSelector} ref={dropdownRef}>
            <button
              style={styles.statusButton}
              onClick={() => setDropdownOpen((prev) => !prev)}
            >
              <span style={{ ...styles.statusDot, backgroundColor: currentOption.color }} />
              {currentOption.label}
            </button>
            {dropdownOpen && (
              <div style={styles.statusDropdown}>
                {STATUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    style={{
                      ...styles.statusOption,
                      background: option.value === currentStatus ? '#334155' : 'transparent',
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#334155'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.background = option.value === currentStatus ? '#334155' : 'transparent'; }}
                    onClick={() => {
                      setStatus(option.value);
                      setDropdownOpen(false);
                    }}
                  >
                    <span style={{ ...styles.statusDot, backgroundColor: option.color }} />
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button style={styles.logoutBtn} onClick={logout}>
          Logout
        </button>
      </div>
    </div>
  );
};
