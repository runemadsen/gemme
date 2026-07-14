import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TYPE_EXT = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/avif': 'avif',
};

/** File extension for a rendition content type. */
export function extForType(contentType) {
  return TYPE_EXT[contentType] || 'bin';
}

/**
 * Store for derived artifacts — image **renditions** (resized/reformatted
 * variants, of which the thumbnail is just one). Parallels the blob store:
 * variants are keyed by the *source* version's content hash plus a `sig`
 * (a canonical hash of the transform) and the output extension, so identical
 * source bytes + identical transform share one file and are naturally tied to
 * the exact bytes they were generated from — even across collections.
 *
 *   <dataDir>/derived/<aa>/<bb>/<hash>.<sig>.<ext>
 */
export class DerivedStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'derived');
  }

  variantPath(hash, sig, ext) {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${sig}.${ext}`);
  }

  hasVariant(hash, sig, ext) {
    return fs.existsSync(this.variantPath(hash, sig, ext));
  }

  /** fs.Stats for a variant (size + mtime feed a cache validator). */
  statVariant(hash, sig, ext) {
    return fs.statSync(this.variantPath(hash, sig, ext));
  }

  async putVariant(hash, sig, ext, buffer) {
    const dest = this.variantPath(hash, sig, ext);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${crypto.randomUUID()}`;
    try {
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, dest); // atomic; concurrent identical writes are safe
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return dest;
  }

  createVariantReadStream(hash, sig, ext) {
    return fs.createReadStream(this.variantPath(hash, sig, ext));
  }
}
