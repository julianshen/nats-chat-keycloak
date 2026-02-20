import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { NatsConnection, Codec } from 'nats.ws';
import type { UserSearchResult } from '../types';
import { tracedHeaders } from '../utils/tracing';

interface Props {
  onSend: (text: string, mentions?: string[]) => void;
  disabled: boolean;
  room: string;
  nc?: NatsConnection | null;
  sc?: Codec<string>;
  connected?: boolean;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 20px',
    borderTop: '1px solid #334155',
    background: '#1e293b',
    position: 'relative',
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
  dropdown: {
    position: 'absolute' as const,
    bottom: '100%',
    left: '20px',
    right: '20px',
    background: '#1e293b',
    border: '1px solid #475569',
    borderRadius: '8px',
    maxHeight: '180px',
    overflowY: 'auto' as const,
    boxShadow: '0 -4px 12px rgba(0,0,0,0.4)',
    zIndex: 50,
    marginBottom: '4px',
  },
  dropdownItem: {
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#cbd5e1',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  dropdownItemActive: {
    background: '#334155',
  },
  dropdownAt: {
    fontWeight: 700,
    color: '#6366f1',
  },
  dropdownName: {
    fontSize: '11px',
    color: '#64748b',
    marginLeft: '4px',
  },
  dropdownLoading: {
    padding: '8px 12px',
    fontSize: '12px',
    color: '#64748b',
  },
};

export const MessageInput: React.FC<Props> = ({ onSend, disabled, room, nc, sc, connected }) => {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number>(0);
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect @ trigger from cursor position
  const detectMention = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? 0;
    const val = input.value;

    // Look backwards from cursor for @ trigger
    let atPos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === '@') {
        // Ensure @ is at start of input or preceded by whitespace
        if (i === 0 || /\s/.test(val[i - 1])) {
          atPos = i;
        }
        break;
      }
      if (/\s/.test(ch)) break;
    }

    if (atPos >= 0) {
      const partial = val.slice(atPos + 1, cursor);
      if (partial.length >= 1 && /^[\w][\w-]*$/.test(partial)) {
        setMentionQuery(partial);
        setMentionStart(atPos);
        return;
      }
    }
    setMentionQuery(null);
    setSearchResults([]);
  }, []);

  // Debounced search via NATS
  useEffect(() => {
    if (mentionQuery === null || !nc || !sc || !connected) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    setActiveIndex(0);

    debounceRef.current = setTimeout(async () => {
      try {
        const { headers: searchHdr } = tracedHeaders();
        const reply = await nc.request('users.search', sc.encode(mentionQuery), { timeout: 5000, headers: searchHdr });
        const results = JSON.parse(sc.decode(reply.data)) as UserSearchResult[];
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mentionQuery, nc, sc, connected]);

  const selectUser = useCallback((username: string) => {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? 0;
    const before = text.slice(0, mentionStart);
    const after = text.slice(cursor);
    const newText = `${before}@${username} ${after}`;
    setText(newText);
    setMentionQuery(null);
    setSearchResults([]);

    // Restore focus and cursor position after React re-render
    const newCursorPos = mentionStart + username.length + 2; // @username + space
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(newCursorPos, newCursorPos);
    });
  }, [text, mentionStart]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionQuery !== null && searchResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % searchResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + searchResults.length) % searchResults.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectUser(searchResults[activeIndex].username);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        setSearchResults([]);
        return;
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed && !disabled) {
      // Extract all @mentions from text
      const mentionMatches = trimmed.match(/@(\w[\w-]*)/g);
      const mentions = mentionMatches
        ? [...new Set(mentionMatches.map((m) => m.slice(1)))]
        : undefined;
      onSend(trimmed, mentions);
      setText('');
      setMentionQuery(null);
      setSearchResults([]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    // Defer mention detection to after React updates the value
    requestAnimationFrame(detectMention);
  };

  const showDropdown = mentionQuery !== null && (searching || searchResults.length > 0);

  return (
    <div style={styles.container}>
      {showDropdown && (
        <div style={styles.dropdown}>
          {searching && searchResults.length === 0 && (
            <div style={styles.dropdownLoading}>Searching...</div>
          )}
          {searchResults.map((user, i) => (
            <div
              key={user.username}
              style={{
                ...styles.dropdownItem,
                ...(i === activeIndex ? styles.dropdownItemActive : {}),
              }}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent input blur
                selectUser(user.username);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span style={styles.dropdownAt}>@</span>
              {user.username}
              {(user.firstName || user.lastName) && (
                <span style={styles.dropdownName}>
                  ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <form style={styles.form} onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          style={{
            ...styles.input,
            ...(disabled ? styles.disabled : {}),
          }}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={detectMention}
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
