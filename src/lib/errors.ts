/** Base error for relay server operations */
export class RelayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export class UnauthorizedError extends RelayError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class SessionNotFoundError extends RelayError {
  constructor(sessionId: string) {
    super('SESSION_NOT_FOUND', `Session ${sessionId} not found or expired`, 404);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionCompletedError extends RelayError {
  constructor(sessionId: string) {
    super('SESSION_COMPLETED', `Session ${sessionId} already processed`, 409);
    this.name = 'SessionCompletedError';
  }
}

export class IncompleteChunksError extends RelayError {
  constructor(
    public readonly expected: number,
    public readonly received: number,
  ) {
    super(
      'INCOMPLETE_CHUNKS',
      `Expected ${expected} chunks, received ${received}`,
      400,
    );
    this.name = 'IncompleteChunksError';
  }
}

export class DecryptionError extends RelayError {
  constructor(message = 'Decryption failed — check encryption key') {
    super('DECRYPTION_FAILED', message, 400);
    this.name = 'DecryptionError';
  }
}

export class GitOperationError extends RelayError {
  constructor(operation: string, detail: string) {
    super('GIT_ERROR', `Git ${operation} failed: ${detail}`, 500);
    this.name = 'GitOperationError';
  }
}
