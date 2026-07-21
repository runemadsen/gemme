import { definePlugin } from '@gemme/plugin-api';
import exifr from 'exifr';
import { IMAGE_MIME, IMAGE_EXT, RAW_EXT, WEB_IMAGE_EXT, EXIF_MAP, RENDER_FORMATS, MAX_EDGE } from './constants.js';
import { imageSize, pushDimensions, rafPreview, embeddedPreview, renderImage } from './utils.js';

/** Bytes sharp can decode, from the source buffer or a RAW's embedded preview. */
async function decodableBuffer(source) {
  const buf = await source.loadBuffer();
  if (RAW_EXT.test(source.filename || '')) {
    return rafPreview(buf) || (await embeddedPreview(buf));
  }
  return buf;
}

/**
 * Parse a rendition spec segment like `w=800,fit=cover.webp` → raw params
 * `{ w, h, fit, q }` (the extension is handled by the core dispatcher).
 */
export function parseSpecParams(segment) {
  const base = segment.slice(0, segment.lastIndexOf('.'));
  const params = {};
  for (const tok of base.split(',')) {
    const eq = tok.indexOf('=');
    if (eq !== -1) params[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return params;
}

/** Validate + clamp raw params into a canonical spec (the cache key). Throws on bad `fit`. */
export function normalizeSpec(params) {
  const spec = {};
  const width = clampInt(params.w, 1, MAX_EDGE);
  const height = clampInt(params.h, 1, MAX_EDGE);
  if (width) spec.width = width;
  if (height) spec.height = height;
  if (params.fit != null) {
    if (!['cover', 'contain', 'inside'].includes(params.fit)) throw new Error(`invalid fit: ${params.fit}`);
    spec.fit = params.fit;
  }
  const quality = clampInt(params.q, 1, 100);
  if (quality) spec.quality = quality;
  return spec;
}

/**
 * Image plugin factory. Provides:
 *   - `extract`: dimensions (header parse) + EXIF (camera/lens/exposure/date/GPS);
 *   - `thumbnail`: the single 512px webp grid/detail thumbnail;
 *   - `preview`: the detail-page `<img>` (+ srcset snippet when public);
 *   - `serving`: the on-the-fly resize/reformat service (serves webp/jpg/png/avif
 *     at `/i/:id/<spec>.<ext>`). sharp can't decode RAW, so it first pulls the
 *     embedded JPEG preview (Fuji RAF header, or exifr's thumbnail for TIFF RAW).
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
    async extract({ loadBuffer, filename }) {
      const buffer = await loadBuffer();
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

      return { metadata };
    },

    // The single pre-generated grid/detail thumbnail: a 512px webp.
    thumbnail: {
      contentType: 'image/webp',
      async generate(source) {
        const buf = await decodableBuffer(source);
        if (!buf) return null;
        const out = await renderImage(buf, { width: 512, format: 'webp' });
        return out ? out.data : null;
      },
    },

    // The detail-page preview HTML. Web formats render their bytes directly;
    // RAW/other images fall back to the generated thumbnail (raw bytes won't
    // display). Public images also get a copyable srcset snippet.
    preview(file, h) {
      const name = file.original_filename || '';
      let html;
      if (WEB_IMAGE_EXT.test(name)) html = `<img src="${h.url.download()}" alt="">`;
      else if (file.thumbnail_type) html = `<img src="${h.url.thumbnail()}" alt="">`;
      else return null;

      if (h.isPublic) {
        const snippet = `<img
  src="${h.url.publicServe('w=800.webp')}"
  srcset="${h.url.publicServe('w=400.webp')} 400w, ${h.url.publicServe('w=800.webp')} 800w, ${h.url.publicServe('w=1600.webp')} 1600w"
  sizes="(max-width: 800px) 100vw, 800px"
  alt="">`;
        html += `<p class="sub">Resized / reformatted variants (drop into <code>srcset</code>):</p>
<pre class="snippet">${h.escapeHtml(snippet)}</pre>`;
      }
      return html;
    },

    // Serving capability: the public on-the-fly image resize/reformat service.
    // One `serve` per request; the core caches the result by (source, spec, ext).
    serving: {
      formats: RENDER_FORMATS,
      async serve({ source, segments, ext }, api) {
        const spec = normalizeSpec(parseSpecParams(segments[segments.length - 1]));
        const encoder = ext === 'jpg' ? 'jpeg' : ext;
        return api.rendition({ spec }, ext, `image/${encoder}`, async () => {
          let buf = await source.loadBuffer();
          if (RAW_EXT.test(source.filename || '')) {
            buf = rafPreview(buf) || (await embeddedPreview(buf));
            if (!buf) return null;
          }
          const out = await renderImage(buf, { ...spec, format: ext });
          return out ? out.data : null;
        });
      },
    },
  });
}

/** Parse an integer param and clamp to [min,max]; undefined if not a number. */
function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}
