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

/** File extension for a thumbnail content type. */
export function extForType(contentType) {
  return TYPE_EXT[contentType] || 'bin';
}

/**
 * Store for derived artifacts (currently thumbnails). Parallels the blob store:
 * artifacts are keyed by the *source* version's content hash, so identical
 * files share one derived artifact and a thumbnail is naturally tied to the
 * exact bytes it was generated from.
 *
 *   <dataDir>/derived/<aa>/<bb>/<hash>.thumb.<ext>
 */
export class DerivedStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'derived');
  }

  thumbPath(hash, contentType) {
    const ext = extForType(contentType);
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.thumb.${ext}`);
  }

  hasThumb(hash, contentType) {
    return fs.existsSync(this.thumbPath(hash, contentType));
  }

  /** fs.Stats for a thumbnail (size + mtime feed a cache validator). */
  statThumb(hash, contentType) {
    return fs.statSync(this.thumbPath(hash, contentType));
  }

  async putThumb(hash, contentType, buffer) {
    const dest = this.thumbPath(hash, contentType);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${crypto.randomUUID()}`;
    try {
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return dest;
  }

  createThumbReadStream(hash, contentType) {
    return fs.createReadStream(this.thumbPath(hash, contentType));
  }
}
