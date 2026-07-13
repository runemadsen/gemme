import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt parameters. N=2^15 is a reasonable interactive-login cost.
const KEYLEN = 64;
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;

/**
 * Hash a password for storage. Returns a self-describing string containing the
 * algorithm parameters, salt, and derived key so it can be verified later even
 * if defaults change.
 *
 * Format: scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const { N, r, p } = SCRYPT_OPTS;
  const derived = await scrypt(password, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored hash. Constant-time comparison.
 * @param {string} password
 * @param {string} stored - value produced by hashPassword
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
