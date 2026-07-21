import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TYPE_EXT = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

/** File extension for a rendition content type. */
export function extForType(contentType) {
  return TYPE_EXT[contentType] || 'bin';
}

/**
 * Reject a bundle member path that could escape its bundle directory. Members
 * come from URL segments, so this guards against traversal (`..`), absolute
 * paths, and backslashes. Returns the normalized relative path or null.
 */
export function safeMember(member) {
  if (typeof member !== 'string' || member === '') return null;
  if (member.includes('\\') || member.includes('\0')) return null;
  if (member.startsWith('/')) return null;
  const norm = path.posix.normalize(member);
  if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) return null;
  if (norm.split('/').some((seg) => seg === '..')) return null;
  return norm;
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

  createVariantReadStream(hash, sig, ext, range) {
    return fs.createReadStream(this.variantPath(hash, sig, ext), range);
  }

  // --- bundles: a directory of related artifacts (e.g. an HLS manifest +
  // segments) keyed by (source hash, sig), parallel to single-file variants ---

  /** Directory holding one bundle's members: <root>/<aa>/<bb>/<hash>.<sig>/ */
  bundleDir(hash, sig) {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${sig}`);
  }

  /** A bundle is present iff its directory exists (put atomically, see putBundle). */
  hasBundle(hash, sig) {
    return fs.existsSync(this.bundleDir(hash, sig));
  }

  /**
   * Absolute path for a member inside a bundle, or null if the member path is
   * unsafe (traversal / absolute). Always confined to the bundle dir.
   */
  bundleMemberPath(hash, sig, member) {
    const safe = safeMember(member);
    if (safe == null) return null;
    return path.join(this.bundleDir(hash, sig), safe);
  }

  hasMember(hash, sig, member) {
    const p = this.bundleMemberPath(hash, sig, member);
    return p != null && fs.existsSync(p);
  }

  statMember(hash, sig, member) {
    return fs.statSync(this.bundleMemberPath(hash, sig, member));
  }

  createMemberReadStream(hash, sig, member, range) {
    return fs.createReadStream(this.bundleMemberPath(hash, sig, member), range);
  }

  /**
   * Move a fully-built temp directory into place as the bundle for (hash, sig).
   * The build happens in a temp dir and is renamed atomically, so a half-built
   * bundle is never visible to `hasBundle`/serving. No-op if already present.
   */
  async putBundle(hash, sig, tmpDir) {
    const dest = this.bundleDir(hash, sig);
    if (fs.existsSync(dest)) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      return dest;
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(tmpDir, dest);
    } catch (err) {
      // A concurrent build may have won the race; tolerate that, else clean up.
      if (fs.existsSync(dest)) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } else {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        throw err;
      }
    }
    return dest;
  }

  /** A fresh temp directory (under derived/) for building a bundle before putBundle. */
  async makeTempDir() {
    await fsp.mkdir(this.root, { recursive: true });
    const dir = path.join(this.root, `.tmp-${crypto.randomUUID()}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }
}
