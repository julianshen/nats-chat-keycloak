export interface AppBridge {
  request(action: string, data?: unknown): Promise<unknown>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
  readonly user: { username: string };
  readonly room: string;
  readonly appId: string;
}

export interface ExcalidrawElement {
  id: string;
  version: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface BoardSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface SyncMessage {
  boardId: string;
  elements: ExcalidrawElement[];
  sender: string;
}
