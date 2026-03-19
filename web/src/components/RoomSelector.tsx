import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useChatClient } from '../hooks/useNatsChat';
import { useAllUnreads } from '../hooks/useMessages';
import { RoomCreateModal } from './RoomCreateModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Hash, Lock, AtSign, Plus, X, Shield, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UserSearchResult, RoomInfo } from '../types';

interface Props {
  rooms: string[];
  activeRoom: string;
  onSelectRoom: (room: string) => void;
  onAddRoom: (room: string) => void;
  dmRooms: string[];
  onStartDm: (user: string) => void;
  privateRooms: RoomInfo[];
  onCreateRoom: (name: string, displayName: string) => void;
}

export const RoomSelector: React.FC<Props> = ({ rooms, activeRoom, onSelectRoom, onAddRoom, dmRooms, onStartDm, privateRooms, onCreateRoom }) => {
  const [newRoom, setNewRoom] = useState('');
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const { userInfo } = useAuth();
  const client = useChatClient();
  const { unreadCounts, mentionCounts } = useAllUnreads(client);
  const isAdmin = userInfo?.roles.includes('admin') ?? false;

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
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
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await client.searchUsers(trimmed);
        // Filter out current user
        setSearchResults((results as UserSearchResult[]).filter((u) => u.username !== userInfo?.username));
      } catch (err) {
        console.log('[UserSearch] Search failed:', err);
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, showSearch, client, userInfo]);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newRoom.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (name && !rooms.includes(name)) {
      onAddRoom(name);
      setNewRoom('');
    }
  };

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

  // Extract the other user's name from a DM room key
  const dmDisplayName = (dmRoom: string): string => {
    const parts = dmRoom.replace('dm-', '').split('-');
    const other = parts.find((u) => u !== userInfo?.username) || parts[1];
    return other;
  };

  return (
    <aside className="w-[240px] bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/50">Rooms</h2>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-2">
          {rooms.map((room) => (
            <button
              key={room}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                activeRoom === room
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
              )}
              onClick={() => onSelectRoom(room)}
            >
              <Hash className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="truncate">{room}</span>
              {mentionCounts[room] > 0 && (
                <Badge variant="destructive" className="ml-auto text-[10px] h-5 px-1.5">@{mentionCounts[room]}</Badge>
              )}
              {unreadCounts[room] > 0 && (
                <Badge className={cn('text-[10px] h-5 px-1.5', mentionCounts[room] > 0 ? 'ml-1' : 'ml-auto')}>
                  {unreadCounts[room] > 99 ? '99+' : unreadCounts[room]}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {isAdmin && (
          <>
            <Separator className="my-2" />
            <div className="px-4 py-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500">Admin</span>
            </div>
            <div className="px-2">
              <button
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors text-amber-500',
                  activeRoom === '__admin__' ? 'bg-sidebar-accent font-bold' : 'hover:bg-sidebar-accent/50',
                )}
                onClick={() => onSelectRoom('__admin__')}
              >
                <Shield className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">admin-channel</span>
                {mentionCounts['__admin__'] > 0 && (
                  <Badge variant="destructive" className="ml-auto text-[10px] h-5 px-1.5">@{mentionCounts['__admin__']}</Badge>
                )}
                {unreadCounts['__admin__'] > 0 && (
                  <Badge className={cn('bg-amber-500 text-[10px] h-5 px-1.5', mentionCounts['__admin__'] > 0 ? 'ml-1' : 'ml-auto')}>
                    {unreadCounts['__admin__'] > 99 ? '99+' : unreadCounts['__admin__']}
                  </Badge>
                )}
              </button>
            </div>
          </>
        )}

        <Separator className="my-2" />
        <div className="flex items-center justify-between px-4 py-1">
          <span className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/50">Private Rooms</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-sidebar-foreground/50 hover:text-sidebar-foreground"
            onClick={() => setShowCreateRoom(true)}
            title="Create private room"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="px-2">
          {privateRooms.map((ch) => (
            <button
              key={ch.name}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                activeRoom === ch.name
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
              )}
              onClick={() => onSelectRoom(ch.name)}
            >
              <Lock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="truncate">{ch.displayName || ch.name}</span>
              {mentionCounts[ch.name] > 0 && (
                <Badge variant="destructive" className="ml-auto text-[10px] h-5 px-1.5">@{mentionCounts[ch.name]}</Badge>
              )}
              {unreadCounts[ch.name] > 0 && (
                <Badge className={cn('text-[10px] h-5 px-1.5', mentionCounts[ch.name] > 0 ? 'ml-1' : 'ml-auto')}>
                  {unreadCounts[ch.name] > 99 ? '99+' : unreadCounts[ch.name]}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {showCreateRoom && (
          <RoomCreateModal
            onSubmit={onCreateRoom}
            onClose={() => setShowCreateRoom(false)}
          />
        )}

        <Separator className="my-2" />
        <div className="flex items-center justify-between px-4 py-1">
          <span className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/50">Direct Messages</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-sidebar-foreground/50 hover:text-sidebar-foreground"
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
            <div className="mt-1 max-h-[150px] overflow-y-auto">
              {searching && <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Searching...</div>}
              {!searching && searchResults.length === 0 && searchQuery.trim().length > 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No users found</div>
              )}
              {searchResults.map((user) => (
                <button
                  key={user.username}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-foreground/80 hover:bg-accent cursor-pointer transition-colors"
                  onClick={() => handleSelectUser(user.username)}
                >
                  <AtSign className="h-3 w-3 text-indigo-400" />
                  {user.username}
                  {(user.firstName || user.lastName) && (
                    <span className="text-muted-foreground ml-0.5">
                      ({[user.firstName, user.lastName].filter(Boolean).join(' ')})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="px-2">
          {dmRooms.map((dmRoom) => (
            <button
              key={dmRoom}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                activeRoom === dmRoom
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
              )}
              onClick={() => onSelectRoom(dmRoom)}
            >
              <AtSign className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
              <span className="truncate">{dmDisplayName(dmRoom)}</span>
              {mentionCounts[dmRoom] > 0 && (
                <Badge variant="destructive" className="ml-auto text-[10px] h-5 px-1.5">@{mentionCounts[dmRoom]}</Badge>
              )}
              {unreadCounts[dmRoom] > 0 && (
                <Badge className={cn('text-[10px] h-5 px-1.5', mentionCounts[dmRoom] > 0 ? 'ml-1' : 'ml-auto')}>
                  {unreadCounts[dmRoom] > 99 ? '99+' : unreadCounts[dmRoom]}
                </Badge>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
      <form className="p-3 border-t border-sidebar-border" onSubmit={handleSubmit}>
        <Input
          className="h-8 text-xs"
          placeholder="Add room..."
          value={newRoom}
          onChange={(e) => setNewRoom(e.target.value)}
        />
      </form>
    </aside>
  );
};
