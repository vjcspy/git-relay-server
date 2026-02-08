import { createDecipheriv } from 'node:crypto';

import { DecryptionError } from '../lib/errors';

/**
 * Decrypt AES-256-GCM encrypted data.
 *
 * @param encryptedData - Concatenated chunks (raw encrypted bytes)
 * @param key - 32-byte AES-256 key
 * @param iv - 12-byte initialization vector
 * @param authTag - 16-byte GCM authentication tag
 * @returns Decrypted buffer (patch content)
 * @throws DecryptionError if decryption or integrity check fails
 */
export function decrypt(
  encryptedData: Buffer,
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('auth')) {
      throw new DecryptionError('Data integrity check failed — data may have been tampered');
    }
    throw new DecryptionError(`Decryption failed: ${message}`);
  }
}
