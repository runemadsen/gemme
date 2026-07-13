/**
 * Extract pixel dimensions from common image formats by reading their headers —
 * no image-decoding dependency. Supports PNG, JPEG, GIF, and WebP (VP8/VP8L/VP8X).
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
export function imageSize(buf) {
  if (!buf || buf.length < 16) return null;
  return png(buf) ?? gif(buf) ?? webp(buf) ?? jpeg(buf) ?? null;
}

function png(buf) {
  // 89 50 4E 47 0D 0A 1A 0A, then IHDR chunk with width/height as BE uint32.
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gif(buf) {
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webp(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const format = buf.toString('ascii', 12, 16);
  if (format === 'VP8 ') {
    // lossy: 16-bit width/height (14 bits used) at offset 26
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (format === 'VP8L') {
    const b = buf.subarray(21, 26);
    const bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  return null;
}

function jpeg(buf) {
  if (buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  const len = buf.length;
  while (offset + 9 < len) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0..SOF15 carry dimensions, except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // Skip this segment using its length field.
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null;
}
