import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const HASH_ALGO = 'sha256';

/**
 * Content-addressed blob store. Bytes are stored once under their SHA-256
 * hash, sharded two levels deep to keep directories small:
 *
 *   <dataDir>/blobs/<aa>/<bb>/<full-hash>
 *
 * Identical uploads collapse to the same path, giving free dedup.
 */
export class BlobStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.root = path.join(dataDir, 'blobs');
  }

  /** Absolute on-disk path for a hash (whether or not it exists yet). */
  pathForHash(hash) {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /** @returns {boolean} */
  has(hash) {
    return fs.existsSync(this.pathForHash(hash));
  }

  /**
   * Store a buffer. No-op write if the content already exists.
   * @param {Buffer} buf
   * @returns {Promise<{hash: string, size: number, deduped: boolean}>}
   */
  async putBuffer(buf) {
    const hash = crypto.createHash(HASH_ALGO).update(buf).digest('hex');
    const dest = this.pathForHash(hash);
    if (fs.existsSync(dest)) {
      return { hash, size: buf.length, deduped: true };
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await atomicWrite(dest, async (tmp) => {
      await fsp.writeFile(tmp, buf);
    });
    return { hash, size: buf.length, deduped: false };
  }

  /**
   * Store from a readable stream while hashing on the fly. We stage to a
   * temp file, then move into place once the hash is known.
   * @param {import('node:stream').Readable} readable
   * @returns {Promise<{hash: string, size: number, deduped: boolean}>}
   */
  async putStream(readable) {
    await fsp.mkdir(this.root, { recursive: true });
    const tmp = path.join(this.root, `.tmp-${crypto.randomUUID()}`);
    const hasher = crypto.createHash(HASH_ALGO);
    let size = 0;
    readable.on('data', (chunk) => {
      size += chunk.length;
      hasher.update(chunk);
    });
    try {
      await pipeline(readable, fs.createWriteStream(tmp));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    const hash = hasher.digest('hex');
    const dest = this.pathForHash(hash);
    if (fs.existsSync(dest)) {
      await fsp.rm(tmp, { force: true });
      return { hash, size, deduped: true };
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(tmp, dest);
    return { hash, size, deduped: false };
  }

  /** @returns {Promise<Buffer>} */
  async readBuffer(hash) {
    return fsp.readFile(this.pathForHash(hash));
  }

  /**
   * @param {string} hash
   * @param {{start?:number, end?:number}} [range] - inclusive byte range for
   *   partial (206) responses; omit for the whole file.
   * @returns {import('node:stream').Readable}
   */
  createReadStream(hash, range) {
    return fs.createReadStream(this.pathForHash(hash), range);
  }
}

/**
 * Write via a temp file in the same directory then atomically rename, so a
 * crash mid-write never leaves a partial blob at its final path.
 */
async function atomicWrite(dest, write) {
  const tmp = `${dest}.tmp-${crypto.randomUUID()}`;
  try {
    await write(tmp);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
