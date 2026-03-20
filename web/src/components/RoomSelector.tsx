import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useChatClient } from '../hooks/useNatsChat';
import { useAllUnreads } from '../hooks/useMessages';
import { RoomCreateModal } from './RoomCreateModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Hash, Lock, AtSign, Plus, X, Shield, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { dmOtherUser } from '../utils/chat-utils';
import type { UserSearchResult, RoomInfo } from '../types';

interface Props {
  rooms: string[];
  activeRoom: string;
  onSelectRoom: (room: string) => void;
  dmRooms: string[];
  onStartDm: (user: string) => void;
  privateRooms: RoomInfo[];
  onCreateRoom: (name: string, displayName: string) => Promise<void>;
}

export const RoomSelector: React.FC<Props> = ({ rooms, activeRoom, onSelectRoom, dmRooms, onStartDm, privateRooms, onCreateRoom }) => {
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const { userInfo } = useAuth();
  const client = useChatClient();
  const { unreadCounts, mentionCounts } = useAllUnreads(client);
  const isAdmin = userInfo?.roles.includes('admin') ?? false;

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced user search via ChatClient
  useEffect(() => {
    if (!showSearch || !client || !client.isConnected) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = searchQuery.trim();
    if (trimmed.length === 0) {
      setSearchResults([]);
      setSearching(false);
      setSearchError(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await client.searchUsers(trimmed);
        setSearchResults((results as UserSearchResult[]).filter((u) => u.username !== userInfo?.username));
        setSearchError(false);
      } catch (err) {
        console.warn('[UserSearch] Search failed:', err);
        setSearchResults([]);
        setSearchError(true);
      }
      setSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, showSearch, client, userInfo]);

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const handleSelectUser = (username: string) => {
    onStartDm(username);
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleToggleSearch = () => {
    setShowSearch((prev) => !prev);
    if (showSearch) {
      setSearchQuery('');
      setSearchResults([]);
    }
  };

  const dmDisplayName = (dmRoom: string): string => dmOtherUser(dmRoom, userInfo?.username);

  // Lark-style room item classes
  const roomItemCn = (isActive: boolean) => cn(
    'w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-[13px] cursor-pointer transition-all duration-150',
    isActive
      ? 'bg-primary/10 text-primary font-medium'
      : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground',
  );

  return (
    <aside className="w-[240px] bg-sidebar border-r border-sidebar-border flex flex-col">
      {/* Search / Title bar */}
      <div className="px-3 pt-3 pb-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs bg-sidebar-accent/60 border-transparent focus:border-sidebar-border"
            placeholder="Search..."
            readOnly
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        {/* Rooms Section */}
        <div className="px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Channels</span>
        </div>
        <div className="px-2 space-y-0.5">
          {rooms.map((room) => (
            <button
              key={room}
              className={roomItemCn(activeRoom === room)}
              onClick={() => onSelectRoom(room)}
            >
              <Hash className={cn('h-4 w-4 shrink-0', activeRoom === room ? 'text-primary' : 'opacity-40')} />
              <span className="truncate flex-1 text-left">{room}</span>
              {mentionCounts[room] > 0 && (
                <Badge variant="destructive" className="text-[10px] h-[18px] px-1.5 rounded-full">@{mentionCounts[room]}</Badge>
              )}
              {unreadCounts[room] > 0 && (
                <Badge className={cn('text-[10px] h-[18px] px-1.5 rounded-full bg-primary', mentionCounts[room] > 0 && 'ml-0')}>
                  {unreadCounts[room] > 99 ? '99+' : unreadCounts[room]}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {isAdmin && (
          <>
            <div className="px-3 pt-4 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-500">Admin</span>
            </div>
            <div className="px-2">
              <button
                className={cn(
                  roomItemCn(activeRoom === '__admin__'),
                  activeRoom !== '__admin__' && 'text-amber-600 dark:text-amber-400',
                )}
                onClick={() => onSelectRoom('__admin__')}
              >
                <Shield className="h-4 w-4 shrink-0" />
                <span className="truncate flex-1 text-left">admin-channel</span>
                {mentionCounts['__admin__'] > 0 && (
                  <Badge variant="destructive" className="text-[10px] h-[18px] px-1.5 rounded-full">@{mentionCounts['__admin__']}</Badge>
                )}
                {unreadCounts['__admin__'] > 0 && (
                  <Badge className={cn('text-[10px] h-[18px] px-1.5 rounded-full bg-amber-500', mentionCounts['__admin__'] > 0 && 'ml-0')}>
                    {unreadCounts['__admin__'] > 99 ? '99+' : unreadCounts['__admin__']}
                  </Badge>
                )}
              </button>
            </div>
          </>
        )}

        {/* Private Rooms */}
        <div className="flex items-center justify-between px-3 pt-4 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Private Rooms</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground rounded"
            onClick={() => setShowCreateRoom(true)}
            title="Create private room"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="px-2 space-y-0.5">
          {privateRooms.map((ch) => (
            <button
              key={ch.name}
              className={roomItemCn(activeRoom === ch.name)}
              onClick={() => onSelectRoom(ch.name)}
            >
              <Lock className={cn('h-4 w-4 shrink-0', activeRoom === ch.name ? 'text-primary' : 'text-amber-500/70')} />
              <span className="truncate flex-1 text-left">{ch.displayName || ch.name}</span>
              {mentionCounts[ch.name] > 0 && (
                <Badge variant="destructive" className="text-[10px] h-[18px] px-1.5 rounded-full">@{mentionCounts[ch.name]}</Badge>
              )}
              {unreadCounts[ch.name] > 0 && (
                <Badge className={cn('text-[10px] h-[18px] px-1.5 rounded-full bg-primary', mentionCounts[ch.name] > 0 && 'ml-0')}>
                  {unreadCounts[ch.name] > 99 ? '99+' : unreadCounts[ch.name]}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {/* Direct Messages */}
        <div className="flex items-center justify-between px-3 pt-4 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Direct Messages</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground rounded"
            onClick={handleToggleSearch}
            title="New direct message"
          >
            {showSearch ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {showSearch && (
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                className="h-8 pl-8 text-xs"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="mt-1.5 max-h-[150px] overflow-y-auto space-y-0.5">
              {searchError && <div className="px-2 py-1.5 text-xs text-destructive">Search unavailable</div>}
              {searching && !searchError && <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Searching...</div>}
              {!searching && !searchError && searchResults.length === 0 && searchQuery.trim().length > 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No users found</div>
              )}
              {searchResults.map((user) => (
                <button
                  key={user.username}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-foreground hover:bg-accent cursor-pointer transition-colors"
                  onClick={() => handleSelectUser(user.username)}
                >
                  <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-semibold text-primary">{user.username.charAt(0).toUpperCase()}</span>
                  </div>
                  {user.username}
                  {(user.firstName || user.lastName) && (
                    <span className="text-muted-foreground">
                      ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="px-2 space-y-0.5 pb-2">
          {dmRooms.map((dmRoom) => (
            <button
              key={dmRoom}
              className={roomItemCn(activeRoom === dmRoom)}
              onClick={() => onSelectRoom(dmRoom)}
            >
              <div className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-semibold',
                activeRoom === dmRoom ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
              )}>
                {dmDisplayName(dmRoom).charAt(0).toUpperCase()}
              </div>
              <span className="truncate flex-1 text-left">{dmDisplayName(dmRoom)}</span>
              {mentionCounts[dmRoom] > 0 && (
                <Badge variant="destructive" className="text-[10px] h-[18px] px-1.5 rounded-full">@{mentionCounts[dmRoom]}</Badge>
              )}
              {unreadCounts[dmRoom] > 0 && (
                <Badge className={cn('text-[10px] h-[18px] px-1.5 rounded-full bg-primary', mentionCounts[dmRoom] > 0 && 'ml-0')}>
                  {unreadCounts[dmRoom] > 99 ? '99+' : unreadCounts[dmRoom]}
                </Badge>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
      {showCreateRoom && (
        <RoomCreateModal
          onSubmit={onCreateRoom}
          onClose={() => setShowCreateRoom(false)}
        />
      )}
    </aside>
  );
};
