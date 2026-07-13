import { HttpError } from './respond.js';

/**
 * Receive a single uploaded file as a raw request body and stream it into the
 * content-addressed blob store. Filename and content type travel in headers.
 *
 * This is the one module that knows the upload wire format — isolated so it can
 * be swapped for multipart parsing later without touching callers.
 *
 *   Headers:
 *     X-Filename:    URL-encoded original filename (required)
 *     Content-Type:  the file's MIME type (optional; defaults to octet-stream)
 *
 * @returns {Promise<{filename:string, mimeType:string, hash:string, size:number, deduped:boolean}>}
 */
export async function receiveUpload(req, blobStore) {
  const rawName = req.headers['x-filename'];
  if (!rawName) throw new HttpError(400, 'Missing X-Filename header');
  let filename;
  try {
    filename = decodeURIComponent(rawName).trim();
  } catch {
    throw new HttpError(400, 'Invalid X-Filename header');
  }
  if (!filename) throw new HttpError(400, 'Empty filename');

  const mimeType = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();

  const { hash, size, deduped } = await blobStore.putStream(req);
  if (size === 0) throw new HttpError(400, 'Empty upload');

  return { filename, mimeType, hash, size, deduped };
}
