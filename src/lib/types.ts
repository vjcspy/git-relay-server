/** Session status state machine: receiving → processing → pushed | failed */
export type SessionStatus = 'receiving' | 'processing' | 'pushed' | 'failed';

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

/** POST /api/patches/chunk request body */
export interface ChunkRequest {
  sessionId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // base64 encoded encrypted chunk
}

/** POST /api/patches/complete request body */
export interface CompleteRequest {
  sessionId: string;
  repo: string; // "owner/repo"
  branch: string;
  baseBranch: string;
  iv: string; // base64 encoded IV (12 bytes)
  authTag: string; // base64 encoded auth tag (16 bytes)
}

/** GET /api/patches/status/:sessionId response */
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
