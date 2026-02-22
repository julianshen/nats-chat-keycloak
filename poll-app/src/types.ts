export interface AppBridge {
  request(action: string, data?: unknown): Promise<unknown>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
  readonly user: { username: string };
  readonly room: string;
  readonly appId: string;
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  createdBy: string;
  closed: boolean;
}

export interface VoteInfo {
  count: number;
}

export interface PollResults {
  totalVotes: number;
  votes: VoteInfo[];
  userVote: number | null;
}
