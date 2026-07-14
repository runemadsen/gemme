import { definePlugin } from '@gemme/plugin-api';
import exifr from 'exifr';
import { IMAGE_MIME, IMAGE_EXT, RAW_EXT, EXIF_MAP } from './constants.js';
import { imageSize, pushDimensions, rafPreview, embeddedPreview, makeThumbnail } from './utils.js';

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
      return IMAGE_MIME.test(mimeType || '') || IMAGE_EXT.test(filename || '') || RAW_EXT.test(filename || '');
    },
    async extract({ buffer, filename, thumbnailTarget, prior }) {
      const metadata = [];
      const isRaw = RAW_EXT.test(filename || '');

      // Fuji RAF isn't TIFF-based, so exifr can't read it directly — but it embeds
      // a full-size JPEG preview we can slice out. TIFF-based RAW (ARW/NEF/CR2/
      // DNG/…) is read by exifr straight from the buffer.
      const rafJpeg = isRaw ? rafPreview(buffer) : null;

      // Parse EXIF once. For RAF the EXIF lives inside the embedded JPEG; for
      // everything else it's in the file itself.
      let tags = null;
      if (wantExif || isRaw) {
        try {
          tags = (await exifr.parse(rafJpeg || buffer, { gps: wantGps })) || {};
        } catch {
          // Not all images carry (parseable) EXIF; ignore and keep what we can.
        }
      }

      if (isRaw) {
        // RAW dimensions come from EXIF — imageSize's header parser would misread
        // a TIFF-based RAW's thumbnail IFD.
        pushDimensions(metadata, tags?.ExifImageWidth ?? tags?.ImageWidth, tags?.ExifImageHeight ?? tags?.ImageHeight);
      } else {
        const size = imageSize(buffer);
        if (size) pushDimensions(metadata, size.width, size.height);
      }

      if (wantExif && tags) {
        for (const [tag, key, type] of EXIF_MAP) {
          if ((key === 'gps_lat' || key === 'gps_lng') && !wantGps) continue;
          const value = tags[tag];
          if (value == null) continue;
          metadata.push({ key, value: type === 'date' ? new Date(value) : value, type });
        }
      }

      // Generate a thumbnail only if one is wanted and no earlier plugin made one.
      // sharp can't decode RAW, so feed it an embedded JPEG preview: the RAF one
      // we already sliced, else the (smaller) exifr thumbnail for TIFF-based RAW.
      let thumbnail;
      if (thumbnailTarget && !prior?.thumbnail) {
        const source = isRaw ? rafJpeg || (await embeddedPreview(buffer)) : buffer;
        if (source) thumbnail = await makeThumbnail(source, thumbnailTarget);
      }

      return thumbnail ? { metadata, thumbnail } : { metadata };
    },
  });
}
