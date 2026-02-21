import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { NatsConnection, Codec } from 'nats.ws';
import type { UserSearchResult } from '../types';
import { tracedHeaders } from '../utils/tracing';
import { StickerMarket } from './StickerMarket';

interface Props {
  onSend: (text: string, mentions?: string[]) => void;
  onSendSticker?: (stickerUrl: string) => void;
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
  toolbar: {
    display: 'flex',
    gap: '2px',
    padding: '4px 6px',
    background: '#0f172a',
    borderRadius: '8px 8px 0 0',
    border: '1px solid #334155',
    borderBottom: 'none',
  },
  toolBtn: {
    padding: '4px 8px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: '4px',
    color: '#94a3b8',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1.2,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '28px',
  },
  toolBtnHover: {
    background: '#1e293b',
    borderColor: '#475569',
    color: '#e2e8f0',
  },
  toolSep: {
    width: '1px',
    background: '#334155',
    margin: '2px 4px',
    alignSelf: 'stretch',
  },
  form: {
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-end',
  },
  inputWrapper: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  textarea: {
    flex: 1,
    padding: '10px 14px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderTop: 'none',
    borderRadius: '0 0 8px 8px',
    color: '#e2e8f0',
    fontSize: '14px',
    outline: 'none',
    resize: 'none' as const,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    minHeight: '42px',
    maxHeight: '160px',
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
    alignSelf: 'flex-end',
    marginBottom: '1px',
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
  shortcutHint: {
    fontSize: '10px',
    color: '#475569',
    marginLeft: '2px',
  },
};

interface ToolbarButton {
  label: React.ReactNode;
  title: string;
  action: () => void;
}

export const MessageInput: React.FC<Props> = ({ onSend, onSendSticker, disabled, room, nc, sc, connected }) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number>(0);
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [showStickerMarket, setShowStickerMarket] = useState(false);

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  // Wrap selected text with markdown syntax, or insert at cursor if no selection
  const wrapSelection = useCallback((prefix: string, suffix: string, placeholder?: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = text.slice(start, end);

    let newText: string;
    let cursorPos: number;

    if (selected) {
      newText = text.slice(0, start) + prefix + selected + suffix + text.slice(end);
      cursorPos = start + prefix.length + selected.length + suffix.length;
    } else {
      const insert = placeholder || '';
      newText = text.slice(0, start) + prefix + insert + suffix + text.slice(end);
      cursorPos = start + prefix.length + insert.length;
    }

    setText(newText);
    requestAnimationFrame(() => {
      ta.focus();
      if (selected) {
        ta.setSelectionRange(cursorPos, cursorPos);
      } else {
        // Select the placeholder so user can type over it
        ta.setSelectionRange(start + prefix.length, cursorPos);
      }
    });
  }, [text]);

  // Insert text at cursor position (for block-level elements)
  const insertAtCursor = useCallback((insertion: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;

    // If cursor is not at the beginning of a line, prepend a newline
    const beforeCursor = text.slice(0, start);
    const needsNewline = beforeCursor.length > 0 && !beforeCursor.endsWith('\n');
    const prefix = needsNewline ? '\n' : '';

    const newText = text.slice(0, start) + prefix + insertion + text.slice(end);
    setText(newText);

    const newPos = start + prefix.length + insertion.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newPos, newPos);
    });
  }, [text]);

  const toolbarButtons: (ToolbarButton | 'sep')[] = [
    {
      label: <strong>B</strong>,
      title: 'Bold (Ctrl+B)',
      action: () => wrapSelection('**', '**', 'bold'),
    },
    {
      label: <em>I</em>,
      title: 'Italic (Ctrl+I)',
      action: () => wrapSelection('*', '*', 'italic'),
    },
    {
      label: <span style={{ textDecoration: 'line-through' }}>S</span>,
      title: 'Strikethrough (Ctrl+Shift+S)',
      action: () => wrapSelection('~~', '~~', 'strikethrough'),
    },
    'sep',
    {
      label: <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>&lt;/&gt;</span>,
      title: 'Inline Code (Ctrl+E)',
      action: () => wrapSelection('`', '`', 'code'),
    },
    {
      label: <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{'{}'}</span>,
      title: 'Code Block',
      action: () => insertAtCursor('```\ncode\n```'),
    },
    'sep',
    {
      label: '\u{1F517}',
      title: 'Link (Ctrl+K)',
      action: () => {
        const ta = textareaRef.current;
        if (!ta) return;
        const selected = text.slice(ta.selectionStart, ta.selectionEnd);
        if (selected) {
          wrapSelection('[', '](url)');
        } else {
          wrapSelection('[', '](url)', 'text');
        }
      },
    },
    'sep',
    {
      label: '\u{2022}',
      title: 'Bulleted List',
      action: () => insertAtCursor('- item\n'),
    },
    {
      label: '1.',
      title: 'Numbered List',
      action: () => insertAtCursor('1. item\n'),
    },
    {
      label: '\u{275D}',
      title: 'Blockquote',
      action: () => insertAtCursor('> quote\n'),
    },
    'sep',
    {
      label: '\u{1F9E9}',
      title: 'Sticker',
      action: () => setShowStickerMarket(true),
    },
  ];

  // Detect @ trigger from cursor position
  const detectMention = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? 0;
    const val = ta.value;

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
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? 0;
    const before = text.slice(0, mentionStart);
    const after = text.slice(cursor);
    const newText = `${before}@${username} ${after}`;
    setText(newText);
    setMentionQuery(null);
    setSearchResults([]);

    // Restore focus and cursor position after React re-render
    const newCursorPos = mentionStart + username.length + 2; // @username + space
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newCursorPos, newCursorPos);
    });
  }, [text, mentionStart]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;

    // Mention dropdown navigation
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
      if (e.key === 'Tab') {
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

    // Formatting shortcuts
    if (isMod && e.key === 'b') {
      e.preventDefault();
      wrapSelection('**', '**', 'bold');
      return;
    }
    if (isMod && e.key === 'i') {
      e.preventDefault();
      wrapSelection('*', '*', 'italic');
      return;
    }
    if (isMod && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      wrapSelection('~~', '~~', 'strikethrough');
      return;
    }
    if (isMod && e.key === 'e') {
      e.preventDefault();
      wrapSelection('`', '`', 'code');
      return;
    }
    if (isMod && e.key === 'k') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (ta) {
        const selected = text.slice(ta.selectionStart, ta.selectionEnd);
        if (selected) {
          wrapSelection('[', '](url)');
        } else {
          wrapSelection('[', '](url)', 'text');
        }
      }
      return;
    }

    // Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      // If mention dropdown is open and has results, select the mention
      if (mentionQuery !== null && searchResults.length > 0) {
        e.preventDefault();
        selectUser(searchResults[activeIndex].username);
        return;
      }
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
      return;
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
      // Reset textarea height
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      });
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
        <div style={styles.inputWrapper}>
          <div style={styles.toolbar}>
            {toolbarButtons.map((btn, idx) => {
              if (btn === 'sep') {
                return <div key={`sep-${idx}`} style={styles.toolSep} />;
              }
              const btnKey = btn.title;
              return (
                <button
                  key={btnKey}
                  type="button"
                  style={{
                    ...styles.toolBtn,
                    ...(hoveredBtn === btnKey ? styles.toolBtnHover : {}),
                  }}
                  title={btn.title}
                  onMouseEnter={() => setHoveredBtn(btnKey)}
                  onMouseLeave={() => setHoveredBtn(null)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent textarea blur
                    btn.action();
                  }}
                  disabled={disabled}
                  tabIndex={-1}
                >
                  {btn.label}
                </button>
              );
            })}
          </div>
          <textarea
            ref={textareaRef}
            style={{
              ...styles.textarea,
              ...(disabled ? styles.disabled : {}),
            }}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onClick={detectMention}
            placeholder={disabled ? 'Connecting...' : `Message #${room}... (Shift+Enter for new line)`}
            disabled={disabled}
            rows={1}
            autoFocus
          />
        </div>
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
      {showStickerMarket && nc && sc && (
        <StickerMarket
          nc={nc}
          sc={sc}
          onSelect={(url) => {
            onSendSticker?.(url);
            setShowStickerMarket(false);
          }}
          onClose={() => setShowStickerMarket(false)}
        />
      )}
    </div>
  );
};
