import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import videoPlugin from '../index.js';
import { selectLadder, buildHlsArgs, buildHls, ffmpegAvailable, ffmpegPath, probe } from '../ffmpeg.js';
import { DEFAULT_LADDER } from '../constants.js';

test('factory returns a valid plugin stamped with apiVersion', () => {
  const p = videoPlugin();
  assert.equal(p.id, 'video');
  assert.equal(p.apiVersion, 1);
  assert.deepEqual(p.serving.formats, ['m3u8', 'ts']);
  assert.equal(typeof p.serving.pregenerate, 'function');
  assert.equal(typeof p.preview, 'function');
});

test('matches video by mime and by extension (generic mime)', () => {
  const p = videoPlugin();
  assert.equal(p.matches('video/mp4', 'a.mp4'), true);
  assert.equal(p.matches('application/octet-stream', 'clip.MOV'), true);
  assert.equal(p.matches('application/octet-stream', 'a.mkv'), true);
  assert.equal(p.matches('image/png', 'a.png'), false);
  assert.equal(p.matches('audio/mpeg', 'a.mp3'), false);
});

test('selectLadder never upscales; caps to source height', () => {
  // 1080 source → all three rungs.
  assert.deepEqual(selectLadder(1080, DEFAULT_LADDER).map((r) => r.height), [1080, 720, 360]);
  // 720 source → drop 1080.
  assert.deepEqual(selectLadder(720, DEFAULT_LADDER).map((r) => r.height), [720, 360]);
  // 500 source → only 360 fits.
  assert.deepEqual(selectLadder(500, DEFAULT_LADDER).map((r) => r.height), [360]);
  // Shorter than every rung → a single rung at the source height (no upscale).
  const tiny = selectLadder(240, DEFAULT_LADDER);
  assert.equal(tiny.length, 1);
  assert.equal(tiny[0].height, 240);
});

test('buildHlsArgs wires split/scale, per-rung maps, var_stream_map, master playlist', () => {
  const rungs = selectLadder(1080, DEFAULT_LADDER);
  const args = buildHlsArgs('in.mp4', '/out', rungs, true).join(' ');
  assert.match(args, /-filter_complex \[0:v\]split=3/);
  assert.match(args, /scale=w=-2:h=1080/);
  assert.match(args, /-var_stream_map v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:360p/);
  assert.match(args, /-master_pl_name master\.m3u8/);
  assert.match(args, /\/out\/%v\/index\.m3u8$/);
});

test('buildHlsArgs omits audio maps when the source has none', () => {
  const rungs = selectLadder(720, DEFAULT_LADDER);
  const args = buildHlsArgs('in.mp4', '/out', rungs, false).join(' ');
  assert.match(args, /-var_stream_map v:0,name:720p v:1,name:360p/);
  assert.doesNotMatch(args, /-map a:0/);
});

test('serving.serve resolves a bundle member via api.member with the right content-type', async () => {
  const { serving } = videoPlugin();
  // Stub api.member: echoes back the member path + content type the plugin chose.
  const api = { member: (memberPath, contentType) => ({ memberPath, contentType }) };
  const master = await serving.serve({ segments: ['master.m3u8'], ext: 'm3u8' }, api);
  assert.deepEqual(master, { memberPath: 'master.m3u8', contentType: 'application/vnd.apple.mpegurl' });
  const seg = await serving.serve({ segments: ['360p', 'seg_000.ts'], ext: 'ts' }, api);
  assert.deepEqual(seg, { memberPath: '360p/seg_000.ts', contentType: 'video/mp2t' });
});

test('preview: HLS player when streamable, progressive fallback otherwise', () => {
  const p = videoPlugin();
  const h = {
    escapeHtml: (s) => s,
    isPublic: false,
    url: {
      download: () => '/api/files/1/download',
      thumbnail: () => '/api/files/1/thumbnail',
      serve: (m) => `/api/files/1/${m}`,
      publicServe: (m) => `/i/1/${m}`,
      asset: (n) => `/plugin-assets/video/${n}`,
    },
  };
  const streamable = p.preview({ id: 1, stream_type: 'hls', thumbnail_type: 'image/webp' }, h);
  assert.match(streamable, /data-hls="\/api\/files\/1\/master\.m3u8"/);
  assert.match(streamable, /plugin-assets\/video\/player\.js/);
  const pending = p.preview({ id: 1, stream_type: null }, h);
  assert.match(pending, /src="\/api\/files\/1\/download"/);
});

// --- real transcode (only when the bundled ffmpeg is installed) -------------
test('extract + thumbnail + HLS build from a generated clip', { skip: !ffmpegAvailable() }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-vid-'));
  try {
    // Generate a ~2s test clip with the bundled ffmpeg.
    const clip = path.join(dir, 'clip.mp4');
    await buildClip(clip);

    const p = videoPlugin();
    const source = { contentPath: clip, filename: 'clip.mp4', mimeType: 'video/mp4', loadBuffer: async () => fsp.readFile(clip) };

    const { metadata } = await p.extract(source);
    const byKey = Object.fromEntries(metadata.map((m) => [m.key, m.value]));
    assert.ok(byKey.duration >= 1, 'duration in seconds');
    assert.equal(byKey.width, 320);
    assert.equal(byKey.height, 240);
    assert.equal(byKey.orientation, 'landscape');

    const thumb = await p.thumbnail.generate(source);
    assert.ok(Buffer.isBuffer(thumb) && thumb.length > 0, 'poster frame produced');

    // The HLS build is what serving.pregenerate runs via api.buildBundle.
    const out = path.join(dir, 'hls');
    await fsp.mkdir(out);
    const meta = await probe(clip);
    await buildHls(clip, out, selectLadder(meta.height, DEFAULT_LADDER), meta.hasAudio);
    const master = await fsp.readFile(path.join(out, 'master.m3u8'), 'utf8');
    assert.match(master, /#EXT-X-STREAM-INF/);
    // 240p source → single rung dir "240p" (or "360p" recipe name), with a playlist + segment.
    const dirs = await fsp.readdir(out);
    const variant = dirs.find((d) => d.endsWith('p'));
    assert.ok(variant, 'a variant directory exists');
    const members = await fsp.readdir(path.join(out, variant));
    assert.ok(members.includes('index.m3u8'));
    assert.ok(members.some((m) => m.endsWith('.ts')));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function buildClip(dest) {
  // testsrc video + sine audio, 2s, 320x240, yuv420p (H.264-friendly).
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
      dest,
    ], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg clip exit ${c}`))));
  });
  await probe(dest); // sanity
}
