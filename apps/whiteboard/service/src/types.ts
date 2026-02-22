export interface ExcalidrawElement {
  id: string;
  version: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface Board {
  id: string;
  room: string;
  name: string;
  elements: ExcalidrawElement[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRequest {
  name: string;
  user: string;
}

export interface LoadRequest {
  boardId: string;
  user: string;
}

export interface DeltaRequest {
  boardId: string;
  elements: ExcalidrawElement[];
  user: string;
}

export interface DeleteRequest {
  boardId: string;
  user: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}
