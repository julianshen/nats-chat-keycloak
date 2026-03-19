import React from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useChatClient } from '../hooks/useNatsChat';
import { useStatus } from '../hooks/usePresence';
import { useAllUnreads } from '../hooks/useMessages';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Circle, LogOut, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_OPTIONS = [
  { value: 'online', label: 'Online', color: 'text-green-500', bg: 'bg-green-500' },
  { value: 'away', label: 'Away', color: 'text-amber-500', bg: 'bg-amber-500' },
  { value: 'busy', label: 'Busy', color: 'text-red-500', bg: 'bg-red-500' },
  { value: 'offline', label: 'Offline', color: 'text-slate-500', bg: 'bg-slate-500' },
];

export const Header: React.FC = () => {
  const { userInfo, logout } = useAuth();
  const client = useChatClient();
  const connected = client?.isConnected ?? false;
  const { status: currentStatus, setStatus } = useStatus(client);
  const { totalMentions } = useAllUnreads(client);

  const currentOption = STATUS_OPTIONS.find((o) => o.value === currentStatus) || STATUS_OPTIONS[0];

  return (
    <header className="flex items-center justify-between px-5 py-3 bg-card border-b border-border">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold text-foreground tracking-tight">NATS Chat</h1>
        {totalMentions > 0 && (
          <Badge variant="destructive" className="text-xs font-bold">
            @ {totalMentions}
          </Badge>
        )}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {connected ? (
            <Wifi className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <WifiOff className="h-3.5 w-3.5 text-red-500" />
          )}
          <span className="text-xs">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {userInfo && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{userInfo.username}</span>
            {userInfo.roles.map((role) => (
              <Badge
                key={role}
                variant="outline"
                className={cn(
                  'text-[10px] uppercase tracking-wider',
                  role === 'admin' && 'border-amber-500/40 text-amber-500',
                  role === 'user' && 'border-blue-500/40 text-blue-500',
                )}
              >
                {role}
              </Badge>
            ))}
          </div>
        )}
        {connected && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-secondary text-secondary-foreground px-3 h-8 text-xs font-medium hover:bg-secondary/80 transition-colors cursor-pointer"
            >
              <Circle className={cn('h-2 w-2 fill-current', currentOption.color)} />
              {currentOption.label}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[130px]">
              {STATUS_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setStatus(option.value)}
                  className={cn(
                    'gap-2 text-sm cursor-pointer',
                    option.value === currentStatus && 'bg-accent',
                  )}
                >
                  <Circle className={cn('h-2 w-2 fill-current', option.color)} />
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="secondary" size="sm" onClick={logout} className="gap-1.5 h-8">
          <LogOut className="h-3.5 w-3.5" />
          Logout
        </Button>
      </div>
    </header>
  );
};
