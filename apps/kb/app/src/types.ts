export interface AppBridge {
  request(action: string, data?: any): Promise<any>;
  subscribe(event: string, callback: (data: any) => void): () => void;
  readonly user: { username: string };
  readonly room: string;
  readonly appId: string;
}

export interface PageSummary {
  id: string;
  title: string;
  updatedBy: string;
  updatedAt: string;
}

export interface Page {
  id: string;
  title: string;
  content: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  editors: string[];
}

export interface PresenceEvent {
  pageId: string;
  editors: string[];
}
