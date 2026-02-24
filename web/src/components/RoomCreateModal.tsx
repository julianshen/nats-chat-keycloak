import React, { useState } from 'react';

interface Props {
  onSubmit: (name: string, displayName: string) => void;
  onClose: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modal: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    padding: '24px',
    width: '380px',
    maxWidth: '90vw',
  },
  title: {
    fontSize: '16px',
    fontWeight: 700,
    color: '#f1f5f9',
    marginBottom: '16px',
  },
  label: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#94a3b8',
    marginBottom: '4px',
    display: 'block',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '6px',
    color: '#e2e8f0',
    fontSize: '14px',
    outline: 'none',
    marginBottom: '12px',
    boxSizing: 'border-box' as const,
  },
  hint: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '-8px',
    marginBottom: '12px',
  },
  error: {
    fontSize: '12px',
    color: '#fca5a5',
    marginBottom: '8px',
  },
  buttons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '8px',
  },
  cancelBtn: {
    padding: '8px 16px',
    background: '#334155',
    border: 'none',
    borderRadius: '6px',
    color: '#94a3b8',
    fontSize: '13px',
    cursor: 'pointer',
  },
  createBtn: {
    padding: '8px 16px',
    background: '#3b82f6',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    fontWeight: 600,
  },
};

const RESERVED = ['general', 'random', 'help', '__admin__'];

export const RoomCreateModal: React.FC<Props> = ({ onSubmit, onClose }) => {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!cleaned) {
      setError('Room name is required');
      return;
    }
    if (cleaned.startsWith('dm-')) {
      setError('Room name cannot start with "dm-"');
      return;
    }
    if (RESERVED.includes(cleaned)) {
      setError('This name is reserved');
      return;
    }
    onSubmit(cleaned, displayName.trim() || cleaned);
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.title}>Create Private Room</div>
        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Room Name</label>
          <input
            style={styles.input}
            placeholder="e.g. project-alpha"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            autoFocus
          />
          <div style={styles.hint}>Lowercase letters, numbers, and hyphens only</div>

          <label style={styles.label}>Display Name (optional)</label>
          <input
            style={styles.input}
            placeholder="e.g. Project Alpha"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />

          {error && <div style={styles.error}>{error}</div>}

          <div style={styles.buttons}>
            <button type="button" style={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button type="submit" style={styles.createBtn}>Create</button>
          </div>
        </form>
      </div>
    </div>
  );
};
