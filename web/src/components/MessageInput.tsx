import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatClient } from '../lib/chat-client';
import type { UserSearchResult } from '../types';
import { StickerMarket } from './StickerMarket';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Bold, Italic, Strikethrough, Code, Braces, Link, List, ListOrdered, Quote, Send, LockKeyhole, Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  onSend: (text: string, mentions?: string[]) => void;
  onSendSticker?: (stickerUrl: string) => void;
  disabled: boolean;
  room: string;
  client: ChatClient | null;
  e2eeEnabled?: boolean;
}

interface ToolbarButton {
  icon: React.ReactNode;
  title: string;
  action: () => void;
}

export const MessageInput: React.FC<Props> = ({ onSend, onSendSticker, disabled, room, client, e2eeEnabled }) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number>(0);
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      icon: <Bold className="h-3.5 w-3.5" />,
      title: 'Bold (Ctrl+B)',
      action: () => wrapSelection('**', '**', 'bold'),
    },
    {
      icon: <Italic className="h-3.5 w-3.5" />,
      title: 'Italic (Ctrl+I)',
      action: () => wrapSelection('*', '*', 'italic'),
    },
    {
      icon: <Strikethrough className="h-3.5 w-3.5" />,
      title: 'Strikethrough (Ctrl+Shift+S)',
      action: () => wrapSelection('~~', '~~', 'strikethrough'),
    },
    'sep',
    {
      icon: <Code className="h-3.5 w-3.5" />,
      title: 'Inline Code (Ctrl+E)',
      action: () => wrapSelection('`', '`', 'code'),
    },
    {
      icon: <Braces className="h-3.5 w-3.5" />,
      title: 'Code Block',
      action: () => insertAtCursor('```\ncode\n```'),
    },
    'sep',
    {
      icon: <Link className="h-3.5 w-3.5" />,
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
      icon: <List className="h-3.5 w-3.5" />,
      title: 'Bulleted List',
      action: () => insertAtCursor('- item\n'),
    },
    {
      icon: <ListOrdered className="h-3.5 w-3.5" />,
      title: 'Numbered List',
      action: () => insertAtCursor('1. item\n'),
    },
    {
      icon: <Quote className="h-3.5 w-3.5" />,
      title: 'Blockquote',
      action: () => insertAtCursor('> quote\n'),
    },
    ...(client && onSendSticker ? [
      'sep' as const,
      {
        icon: <Puzzle className="h-3.5 w-3.5" />,
        title: 'Sticker',
        action: () => setShowStickerMarket(true),
      },
    ] : []),
  ];

  // Detect @ trigger from cursor position
  const detectMention = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? 0;
    const val = ta.value;

    let atPos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === '@') {
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

  // Debounced search via ChatClient
  useEffect(() => {
    if (mentionQuery === null || !client || !client.isConnected) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    setActiveIndex(0);

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await client.searchUsers(mentionQuery);
        setSearchResults(results as UserSearchResult[]);
      } catch {
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mentionQuery, client]);

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

    const newCursorPos = mentionStart + username.length + 2;
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
      const mentionMatches = trimmed.match(/@(\w[\w-]*)/g);
      const mentions = mentionMatches
        ? [...new Set(mentionMatches.map((m) => m.slice(1)))]
        : undefined;
      onSend(trimmed, mentions);
      setText('');
      setMentionQuery(null);
      setSearchResults([]);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      });
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    requestAnimationFrame(detectMention);
  };

  const showDropdown = mentionQuery !== null && (searching || searchResults.length > 0);

  return (
    <div className="relative px-5 py-3 border-t border-border bg-background">
      {/* Mention dropdown */}
      {showDropdown && (
        <div className="absolute bottom-full left-5 right-5 mb-1 bg-popover border border-border rounded-lg max-h-[180px] overflow-y-auto shadow-lg z-50">
          {searching && searchResults.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
          )}
          {searchResults.map((user, i) => (
            <div
              key={user.username}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 cursor-pointer text-sm transition-colors',
                i === activeIndex ? 'bg-accent' : 'hover:bg-accent/50',
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                selectUser(user.username);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="font-bold text-primary">@</span>
              {user.username}
              {(user.firstName || user.lastName) && (
                <span className="text-xs text-muted-foreground ml-1">
                  ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <form className="flex gap-2.5 items-end" onSubmit={handleSubmit}>
        <div className="flex-1 flex flex-col">
          {/* Toolbar */}
          <div className="flex gap-0.5 px-1.5 py-1 bg-muted rounded-t-lg border border-border border-b-0">
            {toolbarButtons.map((btn, idx) => {
              if (btn === 'sep') {
                return <Separator key={`sep-${idx}`} orientation="vertical" className="h-5 mx-1" />;
              }
              return (
                <Tooltip key={btn.title}>
                  <TooltipTrigger
                    className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 cursor-pointer"
                    onMouseDown={(e: React.MouseEvent) => {
                      e.preventDefault();
                      btn.action();
                    }}
                    disabled={disabled}
                    tabIndex={-1}
                  >
                    {btn.icon}
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">{btn.title}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            className={cn(
              'w-full px-3.5 py-2.5 bg-muted border border-border border-t-0 rounded-b-lg text-sm text-foreground outline-none resize-none font-[inherit] leading-relaxed min-h-[42px] max-h-[160px] focus-visible:ring-1 focus-visible:ring-ring',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
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
        {e2eeEnabled && (
          <span className="text-green-600 dark:text-green-400 text-xs flex items-center gap-1 px-2 shrink-0" title="End-to-end encrypted">
            <LockKeyhole className="h-3.5 w-3.5" />
            E2EE
          </span>
        )}
        <Button
          type="submit"
          disabled={disabled || !text.trim()}
          className="gap-1.5 self-end mb-px"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
      </form>
      {showStickerMarket && client && (
        <StickerMarket
          client={client}
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
