import type { ChatMessage } from '../../types';

export interface ChatClientConfig {
  token: string;
  wsUrl: string;
  username: string;
}

export interface SendOptions {
  threadId?: string;
  mentions?: string[];
  sticker?: { productId: string; stickerId: string };
}

export interface MessageUpdate {
  text?: string;
  editedAt?: number;
  isDeleted?: boolean;
  reactions?: Record<string, string[]>;
}

export interface E2EERoomMeta {
  enabled: boolean;
  epoch: number;
  enabledBy?: string;
}

export type DecryptResult =
  | { status: 'plaintext'; text: string }
  | { status: 'decrypted'; text: string }
  | { status: 'no_key'; text: string }
  | { status: 'failed'; text: string; error: string };

export type { ChatMessage };
