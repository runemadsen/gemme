import { fileURLToPath } from 'node:url';
import { definePlugin } from '@gemme/plugin-api';
import { VIDEO_MIME, VIDEO_EXT, DEFAULT_LADDER, HLS_SPEC_VERSION } from './constants.js';
import { probe, selectLadder, buildHls, extractFrame, ffmpegAvailable } from './ffmpeg.js';

const HLS_CONTENT_TYPES = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };

/**
 * Video plugin factory. Everything ffmpeg-shaped lives here, behind the plugin
 * boundary; the server core stays format-agnostic. Provides:
 *   - `extract`   : ffprobe metadata (duration in seconds, dimensions, codecs…);
 *   - `thumbnail` : a poster frame → 512px webp (the single grid/detail thumb);
 *   - `streamer`  : an HLS adaptive-bitrate bundle (master + per-rung playlists);
 *   - `preview`   : the detail-page <video> player (native HLS / shipped hls.js);
 *   - `assets`    : the player script + vendored hls.js it loads.
 *
 * @param {object} [options]
 * @param {object[]} [options.hls.ladder] - ABR ladder override (see DEFAULT_LADDER)
 */
export default function videoPlugin(options = {}) {
  const ladder = options.hls?.ladder ?? DEFAULT_LADDER;

  return definePlugin({
    id: 'video',
    matches(mimeType, filename) {
      return VIDEO_MIME.test(mimeType || '') || VIDEO_EXT.test(filename || '');
    },

    async extract({ contentPath }) {
      if (!ffmpegAvailable() || !contentPath) return { metadata: [] };
      let m;
      try {
        m = await probe(contentPath);
      } catch {
        return { metadata: [] };
      }
      const metadata = [];
      const push = (key, value, type) => {
        if (value != null && value !== '') metadata.push({ key, value, type });
      };
      push('duration', m.duration, 'number'); // seconds → `duration>10s` works
      push('width', m.width, 'number');
      push('height', m.height, 'number');
      if (m.width > 0 && m.height > 0) {
        push('orientation', m.width >= m.height ? 'landscape' : 'portrait', 'text');
      }
      push('fps', m.fps, 'number');
      push('video_codec', m.videoCodec, 'text');
      push('audio_codec', m.audioCodec, 'text');
      push('bitrate', m.bitrate, 'number');
      return { metadata };
    },

    thumbnail: {
      contentType: 'image/webp',
      async generate(source) {
        if (!ffmpegAvailable()) return null;
        // Prefer a frame ~1s in (skips black leader); fall back to the first frame.
        for (const atSeconds of [1, 0]) {
          try {
            const buf = await extractFrame(source.contentPath, { width: 512, atSeconds });
            if (buf && buf.length) return buf;
          } catch {
            /* try the next timestamp */
          }
        }
        return null;
      },
    },

    // Serving capability: an HLS adaptive-bitrate bundle. Members (`master.m3u8`,
    // `<variant>/index.m3u8`, `<variant>/seg_###.ts`) are pre-generated at upload
    // (`pregenerate`) and served read-only (`serve`) — the core never transcodes
    // on a chunk request. `version` keys the bundle cache (bump to invalidate).
    serving: {
      formats: ['m3u8', 'ts'],
      version: HLS_SPEC_VERSION,
      async serve({ segments, ext }, api) {
        return api.member(segments.join('/'), HLS_CONTENT_TYPES[ext] || null);
      },
      async pregenerate({ source }, api) {
        await api.buildBundle(async (outDir) => {
          const meta = await probe(source.contentPath);
          if (!meta.hasVideo) throw new Error('no video stream');
          const rungs = selectLadder(meta.height, ladder);
          await buildHls(source.contentPath, outDir, rungs, meta.hasAudio);
        });
        return 'hls'; // → files.stream_type
      },
    },

    preview(file, h) {
      const poster = file.thumbnail_type ? ` poster="${h.url.thumbnail()}"` : '';
      if (file.stream_type === 'hls') {
        // In-app player: native HLS (Safari/iOS) else hls.js, both shipped here.
        return `<video class="gemme-video" controls playsinline${poster} data-hls="${h.url.serve('master.m3u8')}"></video>
<script src="${h.url.asset('player.js')}"></script>`;
      }
      // No HLS bundle yet (still processing or not transcodable) — progressive
      // playback of the original via HTTP Range still works for web codecs.
      return `<video controls playsinline${poster} src="${h.url.download()}"></video>`;
    },

    // "How to load" help for a public video: the HLS master URL + a copyable
    // <video> snippet. Injected by the core beneath the public `/i/:id` URL.
    // Only meaningful once the HLS bundle exists.
    publicEmbed(file, h) {
      if (file.stream_type !== 'hls') return null;
      const publicUrl = h.url.publicServe('master.m3u8');
      const embed = `<video controls src="${publicUrl}"></video>`;
      return `<p class="sub">Public HLS stream — drop this URL into any player:</p>
<p><code class="url">${publicUrl}</code></p>
<pre class="snippet">${h.escapeHtml(embed)}</pre>`;
    },

    assets: fileURLToPath(new URL('./assets/', import.meta.url)),
  });
}
