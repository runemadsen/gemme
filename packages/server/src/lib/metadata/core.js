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
    { key: 'type', value: categorize(mt), type: 'text', source: 'core' },
    { key: 'mime', value: mt, type: 'text', source: 'core' },
    { key: 'size', value: byteSize, type: 'number', source: 'core' },
    { key: 'created', value: createdAt, type: 'date', source: 'core' },
  ];
}

export function categorize(mimeType) {
  if (/^image\//.test(mimeType)) return 'image';
  if (/^video\//.test(mimeType)) return 'video';
  if (/^audio\//.test(mimeType)) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (/^text\//.test(mimeType) || mimeType === 'application/json' || mimeType === 'application/xml')
    return 'text';
  return 'other';
}
