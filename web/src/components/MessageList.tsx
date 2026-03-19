import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { renderMarkdown } from '../utils/markdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Pencil, Trash2, MessageSquare, Smile, Languages, Eye, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-green-500',
  away: 'bg-amber-500',
  busy: 'bg-red-500',
  offline: 'bg-slate-500',
};

export interface Translation {
  text: string;
  lang: string;
  done?: boolean;
}

interface Props {
  messages: ChatMessage[];
  currentUser: string;
  memberStatusMap?: Record<string, string>;
  replyCounts?: Record<string, number>;
  onReplyClick?: (message: ChatMessage) => void;
  onReadByClick?: (msg: ChatMessage) => Promise<Array<{userId: string; lastRead: number}>>;
  onEdit?: (message: ChatMessage, newText: string) => void;
  onDelete?: (message: ChatMessage) => void;
  onReact?: (message: ChatMessage, emoji: string) => void;
  onTranslate?: (message: ChatMessage, targetLang: string) => void;
  translations?: Record<string, Translation>;
  translatingKeys?: Set<string>;
  unreadAfterTs?: number | null;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

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

  const prevFirstTsRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number>(0);

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
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - prevScrollHeightRef.current;
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevFirstTsRef.current = currentFirstTs;
  }, [messages]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container || !onLoadMore || !hasMore || loadingMore) return;
    if (container.scrollTop < 100) {
      onLoadMore();
    }
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No messages yet. Say something!
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-0.5" ref={containerRef} onScroll={handleScroll}>
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
      {loadingMore && (
        <div className="text-center py-2 text-muted-foreground text-xs flex items-center justify-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading older messages...
        </div>
      )}
      {!loadingMore && hasMore && <div className="text-center py-2 text-muted-foreground text-xs">Scroll up to load more</div>}
      {messages.map((msg, i) => {
        const color = getColor(msg.user);
        const isOwn = msg.user === currentUser;
        const userStatus = memberStatusMap?.[msg.user];
        const threadId = `${msg.room}-${msg.timestamp}`;
        const replyCount = (replyCounts?.[threadId] || 0) + (msg.replyCount || 0);
        const isHovered = hoveredIndex === i;
        const showUnreadSeparator = unreadAfterTs != null
          && msg.timestamp > unreadAfterTs
          && (i === 0 || messages[i - 1].timestamp <= unreadAfterTs);
        const isSystemMessage = msg.user === '__system__' || msg.action === 'system';

        return (
          <React.Fragment key={`${msg.timestamp}-${i}`}>
            {showUnreadSeparator && (
              <div className="flex items-center gap-2 my-2">
                <div className="flex-1 h-px bg-destructive" />
                <span className="text-xs text-destructive font-semibold shrink-0">New</span>
                <div className="flex-1 h-px bg-destructive" />
              </div>
            )}
            {isSystemMessage ? (
              <div className="flex items-center gap-2 mx-4 my-1">
                <div className="flex-1 h-px bg-border" />
                <span className="text-center text-muted-foreground text-xs italic">{msg.text}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
            ) : (
              <div
                className={cn(
                  'relative py-1.5 px-2 flex gap-2.5 items-start rounded-md transition-colors group',
                  isHovered && 'bg-accent/50',
                )}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => { setHoveredIndex(null); setReadByIndex(null); setReadByUsers([]); setEmojiPickerIndex(null); setLangPickerIndex(null); }}
              >
                {/* Avatar */}
                <div className="relative shrink-0">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center font-semibold text-sm text-white shrink-0"
                    style={{ background: color }}
                  >
                    {msg.user.charAt(0).toUpperCase()}
                  </div>
                  {userStatus && (
                    <span className={cn('absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-background', STATUS_COLORS[userStatus] || 'bg-slate-500')} />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="font-bold text-sm" style={{ color: isOwn ? '#60a5fa' : color }}>
                      {msg.user}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{formatTime(msg.timestamp)}</span>
                    {msg.editedAt && !msg.isDeleted && (
                      <span className="text-[11px] text-muted-foreground">(edited)</span>
                    )}
                  </div>

                  {msg.isDeleted ? (
                    <div className="text-sm text-muted-foreground italic">This message was deleted</div>
                  ) : msg.stickerUrl ? (
                    <img src={msg.stickerUrl} alt="sticker" className="max-w-[150px] max-h-[150px] rounded-lg" />
                  ) : editingIndex === i ? (
                    <div>
                      <Input
                        className="h-8 text-sm"
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
                      <div className="flex gap-1 mt-1">
                        <Button
                          size="sm"
                          className="h-6 text-xs px-3"
                          onClick={() => {
                            if (editText.trim() && editText.trim() !== msg.text) {
                              onEdit?.(msg, editText.trim());
                            }
                            setEditingIndex(null);
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-6 text-xs px-3"
                          onClick={() => setEditingIndex(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-foreground/90 leading-relaxed break-words">{renderMessageText(msg.text, currentUser)}</div>
                  )}

                  {/* Reactions */}
                  {!msg.isDeleted && msg.reactions && Object.keys(msg.reactions).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {Object.entries(msg.reactions).map(([emoji, users]) => {
                        const isOwnReaction = users.includes(currentUser);
                        return (
                          <button
                            key={emoji}
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer border transition-colors',
                              isOwnReaction
                                ? 'border-primary/50 bg-primary/10 text-foreground'
                                : 'border-border bg-secondary text-foreground/80 hover:bg-accent',
                            )}
                            onClick={() => onReact?.(msg, emoji)}
                            title={users.join(', ')}
                          >
                            {emoji} {users.length}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Translation */}
                  {(() => {
                    const msgKey = `${msg.timestamp}-${msg.user}`;
                    const translation = translations?.[msgKey];
                    const isTranslating = translatingKeys?.has(msgKey);
                    if (isTranslating && !translation) return <div className="mt-1.5 p-2 rounded-md border border-border bg-card text-xs text-muted-foreground italic">Translating...</div>;
                    if (isTranslating && translation) {
                      const langLabel = LANG_OPTIONS.find(l => l.code === translation.lang)?.label || translation.lang;
                      return (
                        <div className="mt-1.5 p-2 rounded-md border border-border bg-card">
                          <div className="text-[10px] text-muted-foreground font-semibold mb-0.5">Translating ({langLabel})...</div>
                          <div className="text-sm text-cyan-300 leading-relaxed break-words">{translation.text}<span style={{ opacity: 0.6, animation: 'blink 1s step-end infinite' }}>{'\u258B'}</span></div>
                        </div>
                      );
                    }
                    if (translation) {
                      const langLabel = LANG_OPTIONS.find(l => l.code === translation.lang)?.label || translation.lang;
                      return (
                        <div className="mt-1.5 p-2 rounded-md border border-border bg-card">
                          <div className="text-[10px] text-muted-foreground font-semibold mb-0.5">Translated ({langLabel})</div>
                          <div className="text-sm text-cyan-300 leading-relaxed break-words">{renderMessageText(translation.text, currentUser)}</div>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {/* Reply count */}
                  {!msg.isDeleted && replyCount > 0 && (
                    <button
                      className="mt-1 inline-flex items-center gap-1 text-xs text-primary font-semibold hover:underline cursor-pointer bg-transparent border-none"
                      onClick={() => onReplyClick?.(msg)}
                    >
                      <MessageSquare className="h-3 w-3" />
                      {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                    </button>
                  )}
                </div>

                {/* Hover actions */}
                {isHovered && !msg.isDeleted && editingIndex !== i && (
                  <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {isOwn && onEdit && (
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-6 w-6"
                        title="Edit"
                        onClick={() => { setEditingIndex(i); setEditText(msg.text); }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                    {isOwn && onDelete && (
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-6 w-6"
                        title="Delete"
                        onClick={() => onDelete(msg)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                    {!msg.threadId && onReplyClick && (
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-6 w-6"
                        title="Reply"
                        onClick={() => onReplyClick(msg)}
                      >
                        <MessageSquare className="h-3 w-3" />
                      </Button>
                    )}
                    {onReact && (
                      <Popover open={emojiPickerIndex === i} onOpenChange={(open) => setEmojiPickerIndex(open ? i : null)}>
                        <PopoverTrigger className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="React">
                            <Smile className="h-3 w-3" />
                        </PopoverTrigger>
                        <PopoverContent side="top" align="end" className="w-auto p-1.5 flex gap-0.5">
                          {EMOJI_OPTIONS.map((emoji) => (
                            <button
                              key={emoji}
                              className="text-base p-1 rounded hover:bg-accent cursor-pointer bg-transparent border-none leading-none"
                              onClick={() => {
                                onReact?.(msg, emoji);
                                setEmojiPickerIndex(null);
                              }}
                            >
                              {emoji}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    )}
                    {onTranslate && (
                      <Popover open={langPickerIndex === i} onOpenChange={(open) => setLangPickerIndex(open ? i : null)}>
                        <PopoverTrigger className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Translate">
                            <Languages className="h-3 w-3" />
                        </PopoverTrigger>
                        <PopoverContent side="top" align="end" className="w-[150px] p-1">
                          {LANG_OPTIONS.map((lang) => (
                            <button
                              key={lang.code}
                              className="w-full text-left px-2 py-1.5 rounded text-xs text-foreground hover:bg-accent cursor-pointer bg-transparent border-none transition-colors"
                              onClick={() => {
                                onTranslate?.(msg, lang.code);
                                setLangPickerIndex(null);
                              }}
                            >
                              {lang.label}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    )}
                    {onReadByClick && (
                      <Popover open={readByIndex === i} onOpenChange={(open) => {
                        if (open) {
                          setReadByIndex(i);
                          setReadByLoading(true);
                          onReadByClick(msg).then((receipts) => {
                            const readers = receipts.filter(
                              (r) => r.userId !== msg.user && r.lastRead >= msg.timestamp
                            );
                            setReadByUsers(readers);
                            setReadByLoading(false);
                          });
                        } else {
                          setReadByIndex(null);
                          setReadByUsers([]);
                        }
                      }}>
                        <PopoverTrigger className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Read by">
                            <Eye className="h-3 w-3" />
                        </PopoverTrigger>
                        <PopoverContent side="top" align="end" className="w-[140px] p-2">
                          <div className="text-[11px] text-muted-foreground font-semibold mb-1">Read by</div>
                          {readByLoading ? (
                            <div className="text-xs text-muted-foreground italic">Loading...</div>
                          ) : readByUsers.length === 0 ? (
                            <div className="text-xs text-muted-foreground italic">No one yet</div>
                          ) : (
                            readByUsers.map((r) => (
                              <div key={r.userId} className="text-xs text-foreground py-0.5">{r.userId}</div>
                            ))
                          )}
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
