import React, { useState } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  room: string;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 20px',
    borderTop: '1px solid #334155',
    background: '#1e293b',
  },
  form: {
    display: 'flex',
    gap: '10px',
  },
  input: {
    flex: 1,
    padding: '10px 14px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '8px',
    color: '#e2e8f0',
    fontSize: '14px',
    outline: 'none',
  },
  button: {
    padding: '10px 20px',
    background: '#3b82f6',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    fontWeight: 600,
    fontSize: '14px',
    cursor: 'pointer',
  },
  disabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
};

export const MessageInput: React.FC<Props> = ({ onSend, disabled, room }) => {
  const [text, setText] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setText('');
    }
  };

  return (
    <div style={styles.container}>
      <form style={styles.form} onSubmit={handleSubmit}>
        <input
          style={{
            ...styles.input,
            ...(disabled ? styles.disabled : {}),
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? 'Connecting...' : `Message #${room}...`}
          disabled={disabled}
          autoFocus
        />
        <button
          type="submit"
          style={{
            ...styles.button,
            ...(disabled || !text.trim() ? styles.disabled : {}),
          }}
          disabled={disabled || !text.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
};
