export const VIDEO_MIME = /^video\//;
// Match by extension too — browsers send a generic mime for many containers.
export const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|ogv|3gp|ts|mts|m2ts)$/i;

// Default adaptive-bitrate ladder, widest first. Each rung is transcoded only
// when the source is at least that tall (never upscale); if the source is
// shorter than the smallest rung, a single rung at the source height is used.
// `name` becomes the HLS variant sub-directory (`<name>/index.m3u8`).
export const DEFAULT_LADDER = [
  { name: '1080p', height: 1080, videoBitrate: '5000k', maxrate: '5350k', bufsize: '7500k' },
  { name: '720p', height: 720, videoBitrate: '2800k', maxrate: '2996k', bufsize: '4200k' },
  { name: '360p', height: 360, videoBitrate: '800k', maxrate: '856k', bufsize: '1200k' },
];

export const AUDIO_BITRATE = '128k';
export const SEGMENT_SECONDS = 4;

// Bump when the transcode recipe changes so cached bundles are invalidated
// (part of the streamer `spec` → bundle cache signature).
export const HLS_SPEC_VERSION = 1;
