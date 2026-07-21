import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FFPROBE = require('ffprobe-static').path;

/** True when the bundled ffprobe resolved (lets callers degrade gracefully). */
export function ffprobeAvailable() {
  return Boolean(FFPROBE);
}

/** Probe an audio file → normalized fields (all optional). */
export async function probe(input) {
  const json = await run(FFPROBE, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    input,
  ]);
  const data = JSON.parse(json);
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  const bitrate = Number(data.format?.bit_rate ?? a?.bit_rate);
  const sampleRate = Number(a?.sample_rate);
  return {
    duration: Number.isFinite(duration) ? duration : undefined,
    bitrate: Number.isFinite(bitrate) ? bitrate : undefined,
    audioCodec: a?.codec_name,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : undefined,
    channels: a?.channels,
  };
}

/** Spawn with an argv array (no shell) and capture stdout. */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('ffprobe not available'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}: ${err.slice(-300)}`))));
  });
}
