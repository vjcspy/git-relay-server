/** Session status state machine: receiving → complete → processing → pushed | stored | failed */
export type SessionStatus =
  | 'receiving'
  | 'complete'
  | 'processing'
  | 'pushed'
  | 'stored'
  | 'failed';

export interface SessionInfo {
  sessionId: string;
  totalChunks: number;
  receivedChunks: Set<number>;
  status: SessionStatus;
  message: string;
  details: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** POST /api/data/chunk request body */
export interface ChunkRequest {
  sessionId: string;
  chunkIndex: number;
  totalChunks: number;
}

/** POST /api/data/complete request body */
export interface CompleteRequest {
  sessionId: string;
}

/** POST /api/gr/process request body */
export interface GRProcessRequest {
  sessionId: string;
  repo: string; // "owner/repo"
  branch: string;
  baseBranch: string;
}

/** POST /api/file/store request body */
export interface FileStoreRequest {
  sessionId: string;
  fileName: string;
  size: number;
  sha256: string;
}

/** GET /api/data/status/:sessionId response */
export interface StatusResponse {
  sessionId: string;
  status: SessionStatus;
  message: string;
  details?: {
    chunksReceived?: number;
    totalChunks?: number;
    commitSha?: string;
    commitUrl?: string;
    storedPath?: string;
    storedSize?: number;
    error?: string;
  };
}
