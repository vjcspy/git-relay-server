declare global {
  namespace Express {
    interface Request {
      binaryData?: Buffer;
    }
  }
}

export {};
