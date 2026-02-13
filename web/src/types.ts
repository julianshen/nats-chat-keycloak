export interface ChatMessage {
  user: string;
  text: string;
  timestamp: number;
  room: string;
}

export interface UserInfo {
  username: string;
  email: string;
  roles: string[];
}
