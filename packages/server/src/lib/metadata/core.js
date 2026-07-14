import path from 'node:path';

/**
 * "Core" metadata — the fields intrinsic to a version that are known the moment
 * it's created, without any plugin: filename, extension, type category, mime,
 * byte size, and creation date. Computed the same way at upload time (so files
 * are searchable immediately) and during extraction (which re-writes them).
 *
 * @param {{filename:string, mimeType:string, byteSize:number, createdAt:string}} v
 * @returns {Array<{key:string,value:any,type:string,source:'core'}>}
 */
export function coreMetadata({ filename, mimeType, byteSize, createdAt }) {
  const mt = mimeType || 'application/octet-stream';
  return [
    { key: 'filename', value: filename, type: 'text', source: 'core' },
    { key: 'ext', value: path.extname(filename || '').replace(/^\./, '').toLowerCase(), type: 'text', source: 'core' },
    { key: 'type', value: categorize(mt, filename), type: 'text', source: 'core' },
    { key: 'mime', value: mt, type: 'text', source: 'core' },
    { key: 'size', value: byteSize, type: 'number', source: 'core' },
    { key: 'created', value: createdAt, type: 'date', source: 'core' },
  ];
}

// Extension → category. Extension is the primary signal because browsers send a
// generic `application/octet-stream` for many types (notably camera RAW). The
// image set includes RAW formats (keep in sync with plugin-image `RAW_EXT`).
const EXT_CATEGORY = {
  image: 'png jpg jpeg gif webp tif tiff heic avif bmp svg arw sr2 srf cr2 cr3 nef nrw raf orf rw2 dng pef srw 3fr iiq rwl mrw dcr kdc mos',
  video: 'mp4 mov mkv webm avi m4v mpg mpeg',
  audio: 'mp3 wav flac aac ogg oga m4a',
  pdf: 'pdf',
  text: 'txt md markdown csv json xml yaml yml html htm css js ts log',
};
const EXT_TO_CATEGORY = new Map(
  Object.entries(EXT_CATEGORY).flatMap(([cat, exts]) => exts.split(' ').map((e) => [e, cat]))
);

/**
 * Coarse file category for the `type` facet. Decides by extension first (the
 * reliable signal), falling back to MIME when the extension is unknown/absent.
 */
export function categorize(mimeType, filename) {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  const byExt = EXT_TO_CATEGORY.get(ext);
  if (byExt) return byExt;
  if (/^image\//.test(mimeType)) return 'image';
  if (/^video\//.test(mimeType)) return 'video';
  if (/^audio\//.test(mimeType)) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (/^text\//.test(mimeType) || mimeType === 'application/json' || mimeType === 'application/xml')
    return 'text';
  return 'other';
}
