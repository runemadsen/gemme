export const IMAGE_MIME = /^image\//;
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|tiff?|heic|avif)$/i;
// Camera RAW formats. exifr reads their (TIFF-based) EXIF + dimensions, and each
// embeds a JPEG preview we can pull out and hand to sharp — sharp itself can't
// decode RAW. Keep this list in sync with core.js `categorize` (separate pkg).
export const RAW_EXT = /\.(arw|sr2|srf|cr2|cr3|nef|nrw|raf|orf|rw2|dng|pef|srw|3fr|iiq|rwl|mrw|dcr|kdc|mos)$/i;

// Output formats the renderer can emit (URL extensions it serves). `jpg` and
// `jpeg` both map to sharp's 'jpeg' encoder.
export const RENDER_FORMATS = ['webp', 'jpg', 'jpeg', 'png', 'avif'];
// Hard cap on any rendered edge — bounds the cost of a single public request.
export const MAX_EDGE = 4096;

// EXIF tags we surface, mapped to archive metadata keys + types.
export const EXIF_MAP = [
  ['Make', 'camera_make', 'text'],
  ['Model', 'camera_model', 'text'],
  ['LensModel', 'lens', 'text'],
  ['ISO', 'iso', 'number'],
  ['FNumber', 'f_number', 'number'],
  ['ExposureTime', 'exposure_time', 'number'],
  ['FocalLength', 'focal_length', 'number'],
  ['DateTimeOriginal', 'taken_at', 'date'],
  ['latitude', 'gps_lat', 'number'],
  ['longitude', 'gps_lng', 'number'],
];
