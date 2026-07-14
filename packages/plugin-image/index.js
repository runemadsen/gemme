import { definePlugin } from '@gemme/plugin-api';
import exifr from 'exifr';
import sharp from 'sharp';
import { imageSize } from './image-size.js';

const IMAGE_MIME = /^image\//;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|tiff?|heic|avif)$/i;

// EXIF tags we surface, mapped to archive metadata keys + types.
const EXIF_MAP = [
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

/**
 * Image plugin factory. Combines two extractors:
 *   - dimensions: parsed from file headers (zero dependency), always on;
 *   - EXIF: camera/lens/exposure/date/GPS via `exifr`, on by default.
 *
 * @param {object} [options]
 * @param {boolean} [options.exif=true] - extract EXIF tags
 * @param {boolean} [options.gps=true]  - include GPS coordinates from EXIF
 */
export default function imagePlugin(options = {}) {
  const wantExif = options.exif ?? true;
  const wantGps = options.gps ?? true;

  return definePlugin({
    id: 'image',
    matches(mimeType, filename) {
      return IMAGE_MIME.test(mimeType || '') || IMAGE_EXT.test(filename || '');
    },
    async extract({ buffer, thumbnailTarget, prior }) {
      const metadata = [];

      const size = imageSize(buffer);
      if (size) {
        metadata.push({ key: 'width', value: size.width, type: 'number' });
        metadata.push({ key: 'height', value: size.height, type: 'number' });
        if (size.height > 0) {
          metadata.push({
            key: 'orientation',
            value: size.width >= size.height ? 'landscape' : 'portrait',
            type: 'text',
          });
        }
      }

      if (wantExif) {
        try {
          const tags = (await exifr.parse(buffer, { gps: wantGps })) || {};
          for (const [tag, key, type] of EXIF_MAP) {
            if ((key === 'gps_lat' || key === 'gps_lng') && !wantGps) continue;
            const value = tags[tag];
            if (value == null) continue;
            metadata.push({ key, value: type === 'date' ? new Date(value) : value, type });
          }
        } catch {
          // Not all images carry (parseable) EXIF; ignore and keep dimensions.
        }
      }

      // Generate a thumbnail only if one is wanted and no earlier plugin made one.
      let thumbnail;
      if (thumbnailTarget && !prior?.thumbnail) {
        thumbnail = await makeThumbnail(buffer, thumbnailTarget);
      }

      return thumbnail ? { metadata, thumbnail } : { metadata };
    },
  });
}

/**
 * Resize to fit within maxEdge (never upscaling), auto-orienting from EXIF, and
 * encode to the requested format. Returns null if the image can't be decoded.
 */
async function makeThumbnail(buffer, { maxEdge = 512, format = 'webp' } = {}) {
  try {
    const pipeline = sharp(buffer, { failOn: 'none' })
      .rotate() // honor EXIF orientation
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true });
    const data = await pipeline.toFormat(format).toBuffer();
    return { data, contentType: `image/${format}` };
  } catch {
    return null; // undecodable image — skip the thumbnail, keep metadata
  }
}
