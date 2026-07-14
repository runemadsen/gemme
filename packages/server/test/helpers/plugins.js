import { PluginRegistry } from '../../src/lib/plugins/registry.js';

// Minimal PNG dimension read (tests use PNG buffers only).
function pngSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

/**
 * A registry of inline fake plugins that stand in for the real plugin packages.
 * The server test suite exercises the extraction/merge/search *machinery*, not
 * the real plugins (those are tested in @gemme/plugin-text / -image). These
 * fakes mimic just enough behavior for those tests.
 */
export function fakeRegistry() {
  const text = {
    id: 'text',
    matches: (mime, filename) => /^text\//.test(mime || '') || /\.(txt|md)$/i.test(filename || ''),
    async extract({ buffer }) {
      const body = buffer.toString('utf8');
      return {
        metadata: [
          { key: 'char_count', value: body.length, type: 'number' },
          { key: 'word_count', value: body.split(/\s+/).filter(Boolean).length, type: 'number' },
          { key: 'line_count', value: body === '' ? 0 : body.split('\n').length, type: 'number' },
        ],
        fulltext: body,
      };
    },
  };
  const image = {
    id: 'image',
    matches: (mime) => /^image\//.test(mime || ''),
    async extract({ buffer }) {
      const size = pngSize(buffer);
      if (!size) return { metadata: [] };
      return {
        metadata: [
          { key: 'width', value: size.width, type: 'number' },
          { key: 'height', value: size.height, type: 'number' },
          { key: 'orientation', value: size.width >= size.height ? 'landscape' : 'portrait', type: 'text' },
        ],
      };
    },
    // Fake renderer for the rendition engine: no real decoding — just emits
    // deterministic, format-tagged bytes so route/cache/visibility logic can be
    // tested without sharp. (Real resizing is tested in @gemme/plugin-image.)
    renderer: {
      formats: ['webp', 'jpg', 'jpeg', 'png', 'avif'],
      thumbnail: { width: 512, format: 'webp' },
      normalize(params) {
        const spec = {};
        const w = Number.parseInt(params.w, 10);
        const h = Number.parseInt(params.h, 10);
        const q = Number.parseInt(params.q, 10);
        if (Number.isFinite(w)) spec.width = Math.min(4096, Math.max(1, w));
        if (Number.isFinite(h)) spec.height = Math.min(4096, Math.max(1, h));
        if (params.fit != null) {
          if (!['cover', 'contain', 'inside'].includes(params.fit)) throw new Error(`invalid fit: ${params.fit}`);
          spec.fit = params.fit;
        }
        if (Number.isFinite(q)) spec.quality = Math.min(100, Math.max(1, q));
        return spec;
      },
      async run(source, spec) {
        const encoder = spec.format === 'jpg' ? 'jpeg' : spec.format;
        return {
          data: Buffer.from(`RENDITION:${encoder}:${spec.width ?? ''}x${spec.height ?? ''}`),
          contentType: `image/${encoder}`,
        };
      },
    },
  };
  return new PluginRegistry().register(text).register(image);
}
