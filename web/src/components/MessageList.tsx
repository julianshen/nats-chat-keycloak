import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { FileAttachment } from './FileAttachment';
import { ImageViewer } from './ImageViewer';
import type { ImageItem } from './ImageViewer';
import type { ChatClient } from '../lib/chat-client';
import { renderMarkdown } from '../utils/markdown';
import { STATUS_COLORS, formatTime, getAvatarColor, getNameColor } from '../utils/chat-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pencil, Trash2, MessageSquare, Smile, Languages, Eye, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Translation {
  text: string;
  lang: string;
  done?: boolean;
}

interface Props {
  messages: ChatMessage[];
  currentUser: string;
  client?: ChatClient | null;
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

const EMOJI_OPTIONS = ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F389}', '\u{1F525}'];

const LANG_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'pl', label: 'Polish' },
  { code: 'de', label: 'German' },
  { code: 'zh-TW', label: 'Traditional Chinese' },
];

export const MessageList: React.FC<Props> = React.memo(({ messages, currentUser, client, memberStatusMap, replyCounts, onReplyClick, onReadByClick, onEdit, onDelete, onReact, onTranslate, translations, translatingKeys, unreadAfterTs, onLoadMore, hasMore, loadingMore }) => {
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
  const [viewerImages, setViewerImages] = useState<ImageItem[]>([]);
  const [viewerStartIndex, setViewerStartIndex] = useState(0);
  const imageRegistryRef = useRef<Map<number, ImageItem[]>>(new Map());

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
      {loadingMore && (
        <div className="text-center py-2 text-muted-foreground text-xs flex items-center justify-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading older messages...
        </div>
      )}
      {!loadingMore && hasMore && <div className="text-center py-2 text-muted-foreground text-xs">Scroll up to load more</div>}
      {messages.map((msg, i) => {
        const avatarColor = getAvatarColor(msg.user);
        const nameColor = getNameColor(msg.user);
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
                onMouseLeave={() => setHoveredIndex(null)}
              >
                {/* Avatar */}
                <div className="relative shrink-0">
                  <div
                    className={cn('w-8 h-8 rounded-full flex items-center justify-center font-semibold text-sm text-white shrink-0', avatarColor)}
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
                    <span className={cn('font-bold text-sm', isOwn ? 'text-primary' : nameColor)}>
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
                  ) : (msg.fileId || msg.fileIds) ? (
                    <div className="space-y-1">
                      {msg.fileId && (
                        <FileAttachment fileId={msg.fileId} client={client ?? null} onImageClick={(img) => {
                          setViewerImages([img]);
                          setViewerStartIndex(0);
                        }} />
                      )}
                      {msg.fileIds?.map((fid, fi) => (
                        <FileAttachment key={fid} fileId={fid} client={client ?? null} onImageClick={(img) => {
                          // Register this image for the message
                          const registry = imageRegistryRef.current;
                          let msgImages = registry.get(i) || [];
                          const existing = msgImages.findIndex(x => x.src === img.src);
                          if (existing < 0) {
                            msgImages = [...msgImages];
                            msgImages[fi] = img;
                            registry.set(i, msgImages);
                          }
                          // Open viewer with all registered images for this message
                          const allLoaded = registry.get(i)?.filter(Boolean) || [img];
                          const clickedIdx = allLoaded.findIndex(x => x.src === img.src);
                          setViewerImages(allLoaded);
                          setViewerStartIndex(clickedIdx >= 0 ? clickedIdx : 0);
                        }} />
                      ))}
                    </div>
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
                    <div className="text-sm text-foreground/90 leading-relaxed break-words">{renderMarkdown(msg.text, currentUser)}</div>
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
                      const langLabel = LANG_OPTIONS.find(l => l.code === translation.lang)?.label || translation.lang || null;
                      return (
                        <div className="mt-1.5 p-2 rounded-md border border-border bg-card">
                          <div className="text-[10px] text-muted-foreground font-semibold mb-0.5">Translating{langLabel ? ` (${langLabel})` : ''}...</div>
                          <div className="text-sm text-primary leading-relaxed break-words">{translation.text}<span style={{ opacity: 0.6, animation: 'blink 1s step-end infinite' }}>{'\u258B'}</span></div>
                        </div>
                      );
                    }
                    if (translation) {
                      const langLabel = LANG_OPTIONS.find(l => l.code === translation.lang)?.label || translation.lang || null;
                      return (
                        <div className="mt-1.5 p-2 rounded-md border border-border bg-card">
                          <div className="text-[10px] text-muted-foreground font-semibold mb-0.5">Translated{langLabel ? ` (${langLabel})` : ''}</div>
                          <div className="text-sm text-primary leading-relaxed break-words">{renderMarkdown(translation.text, currentUser)}</div>
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
                  <div className="absolute top-1 right-1 flex gap-0.5">
                    {isOwn && onEdit && (
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-6 w-6"
                        title="Edit"
                        aria-label="Edit message"
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
                        aria-label="Delete message"
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
                        aria-label="Reply in thread"
                        onClick={() => onReplyClick(msg)}
                      >
                        <MessageSquare className="h-3 w-3" />
                      </Button>
                    )}
                    {onReact && (
                      <Popover open={emojiPickerIndex === i} onOpenChange={(open) => setEmojiPickerIndex(open ? i : null)}>
                        <PopoverTrigger className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="React" aria-label="Add reaction">
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
                        <PopoverTrigger className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Translate" aria-label="Translate message">
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
                          }).catch(() => {
                            setReadByUsers([]);
                            setReadByLoading(false);
                          });
                        } else {
                          setReadByIndex(null);
                          setReadByUsers([]);
                        }
                      }}>
                        <PopoverTrigger className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-secondary text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Read by" aria-label="Read by">
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
      {viewerImages.length > 0 && (
        <ImageViewer
          images={viewerImages}
          startIndex={viewerStartIndex}
          onClose={() => setViewerImages([])}
        />
      )}
    </div>
  );
});

MessageList.displayName = 'MessageList';
