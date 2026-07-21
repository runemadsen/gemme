import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { definePlugin } from '@gemme/plugin-api';
import { AUDIO_MIME, AUDIO_EXT } from './constants.js';
import { probe, ffprobeAvailable } from './probe.js';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
// The one default thumbnail every audio file shares. Read once at load.
const DEFAULT_THUMB = fs.readFileSync(new URL('./assets/audio.svg', import.meta.url));

/**
 * Audio plugin factory. Provides:
 *   - `extract`   : ffprobe metadata (duration in seconds, codec, bitrate…);
 *   - `thumbnail` : a single default image shared by all audio files;
 *   - `preview`   : a native `<audio controls>` element.
 *
 * There is no `streamer` — audio streams progressively over the core's HTTP
 * Range support (`/api/files/:id/download`, `/i/:id`), which needs no transcode
 * for web-native formats.
 */
export default function audioPlugin() {
  return definePlugin({
    id: 'audio',
    matches(mimeType, filename) {
      return AUDIO_MIME.test(mimeType || '') || AUDIO_EXT.test(filename || '');
    },

    async extract({ contentPath }) {
      if (!ffprobeAvailable() || !contentPath) return { metadata: [] };
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
      push('duration', m.duration, 'number'); // seconds → `duration>30s` works
      push('audio_codec', m.audioCodec, 'text');
      push('bitrate', m.bitrate, 'number');
      push('sample_rate', m.sampleRate, 'number');
      push('channels', m.channels, 'number');
      return { metadata };
    },

    // A default thumbnail shared by every audio file (no per-file rendering).
    thumbnail: {
      contentType: 'image/svg+xml',
      async generate() {
        return DEFAULT_THUMB;
      },
    },

    // Native progressive audio player — the core serves the bytes with Range.
    preview(file, h) {
      return `<audio controls src="${h.url.download()}"></audio>`;
    },

    // "How to load" help for a public audio file: a copyable <audio> embed
    // snippet. Injected by the core beneath the public `/i/:id` URL.
    publicEmbed(file, h) {
      const embed = `<audio controls src="${h.url.publicOriginal()}"></audio>`;
      return `<p class="sub">Plays in any &lt;audio&gt; element:</p>
<pre class="snippet">${h.escapeHtml(embed)}</pre>`;
    },

    assets: ASSETS,
  });
}
