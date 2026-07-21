import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { SEGMENT_SECONDS, AUDIO_BITRATE } from './constants.js';

// Resolve the bundled static binaries. Kept behind the plugin boundary so the
// server core never depends on ffmpeg. `createRequire` lets us read the CJS
// packages' resolved paths from this ESM module.
const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static'); // string path (or null if unavailable)
const FFPROBE = require('ffprobe-static').path;

/** True when both binaries resolved — lets callers/tests degrade gracefully. */
export function ffmpegAvailable() {
  return Boolean(FFMPEG && FFPROBE);
}

export const ffmpegPath = FFMPEG;
export const ffprobePath = FFPROBE;

/**
 * Spawn a binary with an argv array (never a shell string — no injection).
 * Optionally capture stdout as a Buffer. Rejects with stderr on non-zero exit.
 */
function run(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('binary not available'));
    const child = spawn(bin, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    const out = [];
    let err = '';
    if (capture) child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(capture ? Buffer.concat(out) : null);
      else reject(new Error(`${bin.split('/').pop()} exited ${code}: ${err.slice(-500)}`));
    });
  });
}

/** Probe a media file → normalized fields (all optional; missing → undefined). */
export async function probe(input) {
  const json = await run(
    FFPROBE,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input],
    { capture: true }
  );
  const data = JSON.parse(json.toString('utf8'));
  const streams = data.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  const bitrate = Number(data.format?.bit_rate);
  return {
    duration: Number.isFinite(duration) ? duration : undefined,
    bitrate: Number.isFinite(bitrate) ? bitrate : undefined,
    width: v?.width,
    height: v?.height,
    fps: parseFps(v?.avg_frame_rate || v?.r_frame_rate),
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
  };
}

function parseFps(rate) {
  if (!rate || rate === '0/0') return undefined;
  const [n, d] = rate.split('/').map(Number);
  if (!d) return undefined;
  const fps = n / d;
  return Number.isFinite(fps) ? Math.round(fps * 100) / 100 : undefined;
}

/**
 * Choose the ABR rungs to encode from a ladder given the source height: keep
 * rungs no taller than the source (never upscale). If the source is shorter
 * than every rung, encode one rung at the source height. Pure — unit-tested.
 */
export function selectLadder(sourceHeight, ladder) {
  if (!(sourceHeight > 0)) return [ladder[ladder.length - 1]]; // unknown → smallest
  const fit = ladder.filter((r) => r.height <= sourceHeight);
  if (fit.length) return fit;
  const smallest = ladder[ladder.length - 1];
  return [{ ...smallest, name: `${sourceHeight}p`, height: sourceHeight }];
}

/**
 * Build the ffmpeg argv for an HLS ABR transcode. Emits `<outDir>/master.m3u8`
 * plus `<outDir>/<name>/index.m3u8` + `<name>/seg_###.ts` per rung, with
 * relative URLs so the bundle serves under any mount. Pure — unit-tested.
 */
export function buildHlsArgs(input, outDir, rungs, hasAudio) {
  const splits = rungs.map((_, i) => `[v${i}]`).join('');
  const scale = rungs
    .map((r, i) => `[v${i}]scale=w=-2:h=${r.height}[v${i}out]`)
    .join('; ');
  const filter = `[0:v]split=${rungs.length}${splits}; ${scale}`;

  const args = ['-y', '-i', input, '-filter_complex', filter];

  rungs.forEach((r, i) => {
    args.push(
      '-map', `[v${i}out]`,
      `-c:v:${i}`, 'libx264', '-preset', 'veryfast', '-crf', '21',
      // Aligned GOPs (~2s) so segments line up across renditions for clean ABR switching.
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      `-b:v:${i}`, r.videoBitrate, `-maxrate:v:${i}`, r.maxrate, `-bufsize:v:${i}`, r.bufsize
    );
  });
  if (hasAudio) {
    rungs.forEach((_, i) => {
      args.push('-map', 'a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, AUDIO_BITRATE, '-ac', '2');
    });
  }

  // `name:` makes ffmpeg's `%v` expand to a readable variant dir (e.g. `720p/`)
  // instead of a bare index, so member URLs read `hls/720p/seg_000.ts`.
  const varMap = rungs
    .map((r, i) => (hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(' ');
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', `${outDir}/%v/seg_%03d.ts`,
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varMap,
    `${outDir}/%v/index.m3u8`
  );
  return args;
}

/** Transcode `input` into an HLS ABR bundle under `outDir`. */
export async function buildHls(input, outDir, rungs, hasAudio) {
  await run(FFMPEG, buildHlsArgs(input, outDir, rungs, hasAudio));
}

/** Extract one frame as a resized webp Buffer (the poster/grid thumbnail). */
export async function extractFrame(input, { width = 512, atSeconds = 1 } = {}) {
  return run(
    FFMPEG,
    [
      '-y',
      '-ss', String(atSeconds),
      '-i', input,
      '-frames:v', '1',
      '-vf', `scale=w=${width}:h=-2`,
      '-c:v', 'libwebp',
      '-f', 'image2pipe',
      'pipe:1',
    ],
    { capture: true }
  );
}
