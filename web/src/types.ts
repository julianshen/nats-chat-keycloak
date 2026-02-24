export interface ChatMessage {
  user: string;
  text: string;
  timestamp: number;
  room: string;
  threadId?: string;
  parentTimestamp?: number;
  replyCount?: number;
  broadcast?: boolean;
  action?: 'edit' | 'delete' | 'react' | 'system';
  isDeleted?: boolean;
  editedAt?: number;
  reactions?: Record<string, string[]>;
  emoji?: string;
  targetUser?: string;
  mentions?: string[];
  stickerUrl?: string;
}

export interface HistoryResponse {
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface UserInfo {
  username: string;
  email: string;
  roles: string[];
}

export interface UserSearchResult {
  username: string;
  firstName: string;
  lastName: string;
}

export interface RoomInfo {
  name: string;
  displayName?: string;
  creator: string;
  type: string;  // "public" | "private" | "dm"
  members?: Array<{ username: string; role: string }>;
  memberCount?: number;
}
