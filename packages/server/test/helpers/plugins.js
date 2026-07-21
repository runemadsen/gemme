import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry } from '../../src/lib/plugins/registry.js';

// A directory of real files the fake `video` plugin advertises as its `assets`,
// so the generic /plugin-assets/:id/* serving route can be exercised.
const FIXTURE_ASSETS = fileURLToPath(new URL('../fixtures/assets/', import.meta.url));

// Minimal PNG dimension read (tests use PNG buffers only).
function pngSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

/**
 * A registry of inline fake plugins that stand in for the real plugin packages.
 * The server test suite exercises the serving/extraction *machinery*, not the
 * real plugins (those are tested in @gemme/plugin-*). These fakes implement just
 * enough of each capability (extract / thumbnail / preview / renderer / streamer
 * / assets) to drive the core, with deterministic bytes and no ffmpeg/sharp.
 */
export function fakeRegistry() {
  const text = {
    id: 'text',
    matches: (mime, filename) => /^text\//.test(mime || '') || /\.(txt|md)$/i.test(filename || ''),
    async extract({ loadBuffer }) {
      const body = (await loadBuffer()).toString('utf8');
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
    async extract({ loadBuffer }) {
      const size = pngSize(await loadBuffer());
      if (!size) return { metadata: [] };
      return {
        metadata: [
          { key: 'width', value: size.width, type: 'number' },
          { key: 'height', value: size.height, type: 'number' },
          { key: 'orientation', value: size.width >= size.height ? 'landscape' : 'portrait', type: 'text' },
        ],
      };
    },
    // The single pre-generated thumbnail: deterministic bytes, no sharp.
    thumbnail: {
      contentType: 'image/webp',
      async generate() {
        return Buffer.from('THUMB:image');
      },
    },
    preview: (file, h) => `<img src="${h.url.download()}" alt="">`,
    // Mirror the real plugin-image: public "how to load" help lives in publicEmbed
    // (the core injects it beneath the public URL), not in the visual preview.
    publicEmbed: (file, h) =>
      `<pre class="snippet">${h.escapeHtml(`srcset="${h.url.publicServe('w=800.webp')} 800w"`)}</pre>`,
    // Serving: the on-the-fly image transform service (deterministic tagged bytes,
    // no sharp) — exercises the extension-dispatch + variant-cache machinery.
    serving: {
      formats: ['webp', 'jpg', 'jpeg', 'png', 'avif'],
      async serve({ segments, ext }, api) {
        const encoder = ext === 'jpg' ? 'jpeg' : ext;
        const base = segments[segments.length - 1].replace(/\.[^.]+$/, '');
        const params = {};
        for (const tok of base.split(',')) {
          const i = tok.indexOf('=');
          if (i !== -1) params[tok.slice(0, i)] = tok.slice(i + 1);
        }
        const spec = {};
        const w = Number.parseInt(params.w, 10);
        const hh = Number.parseInt(params.h, 10);
        if (Number.isFinite(w)) spec.width = Math.min(4096, Math.max(1, w));
        if (Number.isFinite(hh)) spec.height = Math.min(4096, Math.max(1, hh));
        if (params.fit != null) {
          if (!['cover', 'contain', 'inside'].includes(params.fit)) throw new Error(`invalid fit: ${params.fit}`);
          spec.fit = params.fit;
        }
        return api.rendition({ spec }, ext, `image/${encoder}`, async () =>
          Buffer.from(`RENDITION:${encoder}:${spec.width ?? ''}x${spec.height ?? ''}`)
        );
      },
    },
  };

  const video = {
    id: 'video',
    matches: (mime, filename) => /^video\//.test(mime || '') || /\.(mp4|mov|mkv|webm)$/i.test(filename || ''),
    async extract() {
      return { metadata: [{ key: 'duration', value: 5, type: 'number' }] };
    },
    thumbnail: {
      contentType: 'image/webp',
      async generate() {
        return Buffer.from('THUMB:video');
      },
    },
    preview: (file, h) => `<video controls data-hls="${h.url.serve('master.m3u8')}"></video>`,
    // A fake HLS bundle: pregenerate writes a canned master + one variant
    // playlist + segment; serve reads members back. No ffmpeg.
    serving: {
      formats: ['m3u8', 'ts'],
      version: 1,
      async serve({ segments, ext }, api) {
        const ct = ext === 'm3u8' ? 'application/vnd.apple.mpegurl' : ext === 'ts' ? 'video/mp2t' : null;
        return api.member(segments.join('/'), ct);
      },
      async pregenerate({ source }, api) {
        await api.buildBundle(async (outDir) => {
          await fsp.mkdir(path.join(outDir, '0'), { recursive: true });
          await fsp.writeFile(
            path.join(outDir, 'master.m3u8'),
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n0/index.m3u8\n'
          );
          await fsp.writeFile(path.join(outDir, '0', 'index.m3u8'), '#EXTM3U\nseg_000.ts\n');
          await fsp.writeFile(path.join(outDir, '0', 'seg_000.ts'), Buffer.from('SEGMENT-BYTES'));
        });
        return 'hls';
      },
    },
    assets: FIXTURE_ASSETS,
  };

  return new PluginRegistry().register(text).register(image).register(video);
}
