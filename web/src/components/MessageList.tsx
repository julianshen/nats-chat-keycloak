import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { renderMarkdown } from '../utils/markdown';

const STATUS_COLORS: Record<string, string> = {
  online: '#22c55e',
  away: '#f59e0b',
  busy: '#ef4444',
  offline: '#64748b',
};

export interface Translation {
  text: string;
  lang: string;
}

interface Props {
  messages: ChatMessage[];
  currentUser: string;
  /** Map of userId → status (online, away, busy, offline) */
  memberStatusMap?: Record<string, string>;
  replyCounts?: Record<string, number>;
  onReplyClick?: (message: ChatMessage) => void;
  /** Callback to fetch read receipts on demand. Returns readers whose lastRead >= given timestamp. */
  onReadByClick?: (msg: ChatMessage) => Promise<Array<{userId: string; lastRead: number}>>;
  onEdit?: (message: ChatMessage, newText: string) => void;
  onDelete?: (message: ChatMessage) => void;
  onReact?: (message: ChatMessage, emoji: string) => void;
  onTranslate?: (message: ChatMessage, targetLang: string) => void;
  /** Map of message key → translation result */
  translations?: Record<string, Translation>;
  /** Set of message keys currently being translated */
  translatingKeys?: Set<string>;
  /** Timestamp of the user's last read position. Messages after this get an "unread" separator. */
  unreadAfterTs?: number | null;
  /** Callback to load older messages when scrolling to top */
  onLoadMore?: () => void;
  /** Whether there are more older messages to load */
  hasMore?: boolean;
  /** Whether a load-more request is in progress */
  loadingMore?: boolean;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  messageHoverArea: {
    position: 'relative' as const,
    padding: '6px 0',
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-start',
  },
  avatarWrapper: {
    position: 'relative' as const,
    flexShrink: 0,
  },
  avatar: {
    width: '32px',
    height: '32px',
    borderRadius: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: '14px',
    color: '#fff',
    flexShrink: 0,
  },
  statusDot: {
    position: 'absolute' as const,
    bottom: '-2px',
    right: '-2px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: '2px solid #0f172a',
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    marginBottom: '2px',
  },
  username: {
    fontWeight: 700,
    fontSize: '14px',
  },
  time: {
    fontSize: '11px',
    color: '#64748b',
  },
  text: {
    fontSize: '14px',
    color: '#cbd5e1',
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: '15px',
  },
  replyBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginTop: '4px',
    padding: '2px 8px',
    background: 'transparent',
    border: 'none',
    color: '#3b82f6',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: 600,
  },
  hoverActions: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    display: 'flex',
    gap: '2px',
  },
  hoverButton: {
    padding: '2px 8px',
    background: '#334155',
    border: '1px solid #475569',
    borderRadius: '4px',
    color: '#94a3b8',
    fontSize: '11px',
    cursor: 'pointer',
  },
  readByPopup: {
    position: 'absolute' as const,
    top: '28px',
    right: '4px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    padding: '8px 12px',
    zIndex: 10,
    minWidth: '120px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  readByTitle: {
    fontSize: '11px',
    color: '#64748b',
    marginBottom: '4px',
    fontWeight: 600,
  },
  readByUser: {
    fontSize: '12px',
    color: '#cbd5e1',
    padding: '2px 0',
  },
  readByEmpty: {
    fontSize: '12px',
    color: '#475569',
    fontStyle: 'italic' as const,
  },
  unreadSeparator: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '8px 0',
  },
  unreadLine: {
    flex: 1,
    height: '1px',
    background: '#ef4444',
  },
  unreadLabel: {
    fontSize: '11px',
    color: '#ef4444',
    fontWeight: 600,
    flexShrink: 0,
  },
  loadingMore: {
    textAlign: 'center' as const,
    padding: '8px',
    color: '#64748b',
    fontSize: '12px',
  },
  deletedText: {
    fontSize: '14px',
    color: '#475569',
    fontStyle: 'italic' as const,
  },
  editedLabel: {
    fontSize: '11px',
    color: '#64748b',
    marginLeft: '4px',
  },
  editInput: {
    width: '100%',
    padding: '4px 8px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '4px',
    color: '#e2e8f0',
    fontSize: '14px',
    outline: 'none',
  },
  editActions: {
    display: 'flex',
    gap: '4px',
    marginTop: '4px',
  },
  reactionsBar: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    marginTop: '4px',
  },
  reactionPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    fontSize: '12px',
    color: '#cbd5e1',
    cursor: 'pointer',
    lineHeight: 1.4,
  },
  reactionPillOwn: {
    borderColor: '#3b82f6',
    background: '#1e3a5f',
  },
  emojiPicker: {
    position: 'absolute' as const,
    top: '28px',
    right: '4px',
    display: 'flex',
    gap: '2px',
    padding: '4px 6px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    zIndex: 20,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  emojiPickerBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '4px',
    lineHeight: 1,
  },
  editButton: {
    padding: '2px 10px',
    background: '#2563eb',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '12px',
    cursor: 'pointer',
  },
  cancelButton: {
    padding: '2px 10px',
    background: '#334155',
    border: 'none',
    borderRadius: '4px',
    color: '#94a3b8',
    fontSize: '12px',
    cursor: 'pointer',
  },
  langPicker: {
    position: 'absolute' as const,
    top: '28px',
    right: '4px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    padding: '6px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    zIndex: 20,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    minWidth: '140px',
  },
  langPickerBtn: {
    background: 'transparent',
    border: 'none',
    color: '#cbd5e1',
    fontSize: '12px',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
    textAlign: 'left' as const,
  },
  translationBox: {
    marginTop: '6px',
    padding: '6px 10px',
    background: '#1a2332',
    border: '1px solid #2d3b4e',
    borderRadius: '6px',
    fontSize: '13px',
  },
  translationLabel: {
    fontSize: '10px',
    color: '#64748b',
    marginBottom: '2px',
    fontWeight: 600,
  },
  translationText: {
    color: '#94d3f0',
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  translatingText: {
    color: '#64748b',
    fontSize: '12px',
    fontStyle: 'italic' as const,
  },
};

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4'];

function getColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const EMOJI_OPTIONS = ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F389}', '\u{1F525}'];

const LANG_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'pl', label: 'Polish' },
  { code: 'de', label: 'German' },
  { code: 'zh-TW', label: 'Traditional Chinese' },
];

function renderMessageText(text: string, currentUser: string): React.ReactNode {
  return renderMarkdown(text, currentUser);
}

export const MessageList: React.FC<Props> = ({ messages, currentUser, memberStatusMap, replyCounts, onReplyClick, onReadByClick, onEdit, onDelete, onReact, onTranslate, translations, translatingKeys, unreadAfterTs, onLoadMore, hasMore, loadingMore }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [readByIndex, setReadByIndex] = useState<number | null>(null);
  const [readByUsers, setReadByUsers] = useState<Array<{userId: string; lastRead: number}>>([]);
  const [readByLoading, setReadByLoading] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [emojiPickerIndex, setEmojiPickerIndex] = useState<number | null>(null);
  const [langPickerIndex, setLangPickerIndex] = useState<number | null>(null);

  // Track the first message timestamp to detect prepends vs appends
  const prevFirstTsRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number>(0);

  // Before React commits a render with new messages, snapshot scrollHeight
  // We use useLayoutEffect (via useEffect with []) but need to capture before render
  // Instead, save scrollHeight whenever messages are about to change
  useEffect(() => {
    if (containerRef.current) {
      prevScrollHeightRef.current = containerRef.current.scrollHeight;
    }
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || messages.length === 0) return;

    const currentFirstTs = messages[0].timestamp;
    const prevFirstTs = prevFirstTsRef.current;

    if (prevFirstTs !== null && currentFirstTs < prevFirstTs) {
      // Prepend detected (older messages loaded) — preserve scroll position
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - prevScrollHeightRef.current;
    } else {
      // Append (new message) or initial load — scroll to bottom
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevFirstTsRef.current = currentFirstTs;
  }, [messages]);

  // Scroll-to-top detection for loading more
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container || !onLoadMore || !hasMore || loadingMore) return;
    if (container.scrollTop < 100) {
      onLoadMore();
    }
  };

  if (messages.length === 0) {
    return <div style={styles.empty}>No messages yet. Say something!</div>;
  }

  return (
    <div style={styles.container} ref={containerRef} onScroll={handleScroll}>
      {loadingMore && <div style={styles.loadingMore}>Loading older messages...</div>}
      {!loadingMore && hasMore && <div style={styles.loadingMore}>Scroll up to load more</div>}
      {messages.map((msg, i) => {
        const color = getColor(msg.user);
        const isOwn = msg.user === currentUser;
        const userStatus = memberStatusMap?.[msg.user];
        const dotColor = userStatus ? STATUS_COLORS[userStatus] || STATUS_COLORS.offline : undefined;
        const threadId = `${msg.room}-${msg.timestamp}`;
        const replyCount = (replyCounts?.[threadId] || 0) + (msg.replyCount || 0);
        const isHovered = hoveredIndex === i;
        // Show unread separator before the first unread message
        const showUnreadSeparator = unreadAfterTs != null
          && msg.timestamp > unreadAfterTs
          && (i === 0 || messages[i - 1].timestamp <= unreadAfterTs);
        return (
          <React.Fragment key={`${msg.timestamp}-${i}`}>
          {showUnreadSeparator && (
            <div style={styles.unreadSeparator}>
              <div style={styles.unreadLine} />
              <span style={styles.unreadLabel}>New</span>
              <div style={styles.unreadLine} />
            </div>
          )}
          <div
            style={styles.messageHoverArea}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => { setHoveredIndex(null); setReadByIndex(null); setReadByUsers([]); setEmojiPickerIndex(null); setLangPickerIndex(null); }}
          >
            <div style={styles.avatarWrapper}>
              <div style={{ ...styles.avatar, background: color }}>
                {msg.user.charAt(0).toUpperCase()}
              </div>
              {dotColor && <span style={{ ...styles.statusDot, backgroundColor: dotColor }} />}
            </div>
            <div style={styles.content}>
              <div style={styles.header}>
                <span style={{ ...styles.username, color: isOwn ? '#60a5fa' : color }}>
                  {msg.user}
                </span>
                <span style={styles.time}>{formatTime(msg.timestamp)}</span>
                {msg.editedAt && !msg.isDeleted && (
                  <span style={styles.editedLabel}>(edited)</span>
                )}
              </div>
              {msg.isDeleted ? (
                <div style={styles.deletedText}>This message was deleted</div>
              ) : editingIndex === i ? (
                <div>
                  <input
                    style={styles.editInput}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (editText.trim() && editText.trim() !== msg.text) {
                          onEdit?.(msg, editText.trim());
                        }
                        setEditingIndex(null);
                      } else if (e.key === 'Escape') {
                        setEditingIndex(null);
                      }
                    }}
                    autoFocus
                  />
                  <div style={styles.editActions}>
                    <button
                      style={styles.editButton}
                      onClick={() => {
                        if (editText.trim() && editText.trim() !== msg.text) {
                          onEdit?.(msg, editText.trim());
                        }
                        setEditingIndex(null);
                      }}
                    >
                      Save
                    </button>
                    <button
                      style={styles.cancelButton}
                      onClick={() => setEditingIndex(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={styles.text}>{renderMessageText(msg.text, currentUser)}</div>
              )}
              {!msg.isDeleted && msg.reactions && Object.keys(msg.reactions).length > 0 && (
                <div style={styles.reactionsBar}>
                  {Object.entries(msg.reactions).map(([emoji, users]) => {
                    const isOwnReaction = users.includes(currentUser);
                    return (
                      <button
                        key={emoji}
                        style={{ ...styles.reactionPill, ...(isOwnReaction ? styles.reactionPillOwn : {}) }}
                        onClick={() => onReact?.(msg, emoji)}
                        title={users.join(', ')}
                      >
                        {emoji} {users.length}
                      </button>
                    );
                  })}
                </div>
              )}
              {(() => {
                const msgKey = `${msg.timestamp}-${msg.user}`;
                const translation = translations?.[msgKey];
                const isTranslating = translatingKeys?.has(msgKey);
                if (isTranslating) return <div style={styles.translationBox}><span style={styles.translatingText}>Translating...</span></div>;
                if (translation) {
                  const langLabel = LANG_OPTIONS.find(l => l.code === translation.lang)?.label || translation.lang;
                  return (
                    <div style={styles.translationBox}>
                      <div style={styles.translationLabel}>Translated ({langLabel})</div>
                      <div style={styles.translationText}>{renderMessageText(translation.text, currentUser)}</div>
                    </div>
                  );
                }
                return null;
              })()}
              {!msg.isDeleted && replyCount > 0 && (
                <button
                  style={styles.replyBadge}
                  onClick={() => onReplyClick?.(msg)}
                >
                  {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                </button>
              )}
            </div>
            {isHovered && !msg.isDeleted && editingIndex !== i && (
              <div style={styles.hoverActions}>
                {isOwn && onEdit && (
                  <button
                    style={styles.hoverButton}
                    onClick={() => {
                      setEditingIndex(i);
                      setEditText(msg.text);
                    }}
                  >
                    Edit
                  </button>
                )}
                {isOwn && onDelete && (
                  <button
                    style={styles.hoverButton}
                    onClick={() => onDelete(msg)}
                  >
                    Delete
                  </button>
                )}
                {!msg.threadId && onReplyClick && (
                  <button
                    style={styles.hoverButton}
                    onClick={() => onReplyClick(msg)}
                  >
                    Reply
                  </button>
                )}
                {onReact && (
                  <button
                    style={styles.hoverButton}
                    onClick={() => setEmojiPickerIndex(emojiPickerIndex === i ? null : i)}
                  >
                    &#9786;
                  </button>
                )}
                {onTranslate && (
                  <button
                    style={styles.hoverButton}
                    onClick={() => setLangPickerIndex(langPickerIndex === i ? null : i)}
                  >
                    Translate
                  </button>
                )}
                {onReadByClick && (
                  <button
                    style={styles.hoverButton}
                    onClick={async () => {
                      if (readByIndex === i) {
                        setReadByIndex(null);
                        setReadByUsers([]);
                        return;
                      }
                      setReadByIndex(i);
                      setReadByLoading(true);
                      const receipts = await onReadByClick(msg);
                      const readers = receipts.filter(
                        (r) => r.userId !== msg.user && r.lastRead >= msg.timestamp
                      );
                      setReadByUsers(readers);
                      setReadByLoading(false);
                    }}
                  >
                    Read by
                  </button>
                )}
              </div>
            )}
            {readByIndex === i && (
              <div style={styles.readByPopup}>
                <div style={styles.readByTitle}>Read by</div>
                {readByLoading ? (
                  <div style={styles.readByEmpty}>Loading...</div>
                ) : readByUsers.length === 0 ? (
                  <div style={styles.readByEmpty}>No one yet</div>
                ) : (
                  readByUsers.map((r) => (
                    <div key={r.userId} style={styles.readByUser}>{r.userId}</div>
                  ))
                )}
              </div>
            )}
            {emojiPickerIndex === i && (
              <div style={styles.emojiPicker}>
                {EMOJI_OPTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    style={styles.emojiPickerBtn}
                    onClick={() => {
                      onReact?.(msg, emoji);
                      setEmojiPickerIndex(null);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            {langPickerIndex === i && (
              <div style={styles.langPicker}>
                {LANG_OPTIONS.map((lang) => (
                  <button
                    key={lang.code}
                    style={styles.langPickerBtn}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#334155'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
                    onClick={() => {
                      onTranslate?.(msg, lang.code);
                      setLangPickerIndex(null);
                    }}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          </React.Fragment>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
