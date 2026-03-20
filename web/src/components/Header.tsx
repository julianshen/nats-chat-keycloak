import React from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useChatClient } from '../hooks/useNatsChat';
import { useStatus } from '../hooks/usePresence';
import { useAllUnreads } from '../hooks/useMessages';
import { useTheme } from '../providers/ThemeProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Circle, LogOut, Wifi, WifiOff, Sun, Moon } from 'lucide-react';
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
  const { theme, toggleTheme } = useTheme();

  const currentOption = STATUS_OPTIONS.find((o) => o.value === currentStatus) || STATUS_OPTIONS[0];

  return (
    <header className="flex items-center justify-between px-5 py-2.5 bg-card border-b border-border">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-xs font-bold">N</span>
          </div>
          <h1 className="text-[15px] font-semibold text-foreground">NATS Chat</h1>
        </div>
        {totalMentions > 0 && (
          <Badge variant="destructive" className="text-[10px] font-bold h-5 px-1.5 rounded-full">
            @ {totalMentions}
          </Badge>
        )}
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {connected ? (
            <Wifi className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <WifiOff className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className="text-xs">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {userInfo && (
          <div className="flex items-center gap-2 mr-1">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-primary text-xs font-semibold">{userInfo.username.charAt(0).toUpperCase()}</span>
            </div>
            <span className="text-sm font-medium text-foreground">{userInfo.username}</span>
            {userInfo.roles.map((role) => (
              <Badge
                key={role}
                variant="outline"
                className={cn(
                  'text-[10px] uppercase tracking-wider h-5',
                  role === 'admin' && 'border-amber-500/40 text-amber-500 bg-amber-500/5',
                  role === 'user' && 'border-primary/40 text-primary bg-primary/5',
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
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-secondary text-secondary-foreground px-2.5 h-8 text-xs font-medium hover:bg-accent transition-colors cursor-pointer"
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
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={logout} className="gap-1.5 h-8 text-muted-foreground hover:text-foreground">
          <LogOut className="h-3.5 w-3.5" />
          <span className="text-xs">Logout</span>
        </Button>
      </div>
    </header>
  );
};
