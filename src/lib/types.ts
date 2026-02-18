/** Session status state machine: receiving → complete → processing → pushed | failed */
export type SessionStatus =
  | 'receiving'
  | 'complete'
  | 'processing'
  | 'pushed'
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
    error?: string;
  };
}
