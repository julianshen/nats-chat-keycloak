export interface ChatMessage {
  user: string;
  text: string;
  timestamp: number;
  room: string;
  threadId?: string;
  parentTimestamp?: number;
  replyCount?: number;
  broadcast?: boolean;
}

export interface UserInfo {
  username: string;
  email: string;
  roles: string[];
}
