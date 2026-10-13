import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';

// PNG and zip with node:zlib only (see docs/art.md#imported-art): the RGB
// writer for contact sheets, an RGBA writer and a decoder for imported art,
// and a reader for the source zips. Output is deterministic: one IDAT,
// filter type 0 on every row, no ancillary chunks.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode `channels`-byte pixels (3 = RGB, 4 = RGBA) as an 8-bit PNG. */
function encode(w, h, data, channels) {
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Encode RGB rows (Uint8Array w*h*3) as PNG. */
export function png(w, h, rgb) {
  return encode(w, h, rgb, 3);
}

/** Encode an image `{ width, height, data }` (RGBA, Uint8Array w*h*4) as an 8-bit RGBA PNG. */
export function encodePng(img) {
  return encode(img.width, img.height, img.data, 4);
}

/** Width and height from a PNG's IHDR, without decoding it. */
export function pngSize(buf) {
  if (!SIGNATURE.equals(buf.subarray(0, 8)) || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode an 8-bit, non-interlaced PNG (colour type 0, 2, 3, 4 or 6) to RGBA `{ width, height, data }`. */
export function decodePng(buf) {
  const { width, height } = pngSize(buf);
  const depth = buf[24];
  const type = buf[25];
  const interlace = buf[28];
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (only 8)`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  const channels = CHANNELS[type];
  if (!channels) throw new Error(`PNG colour type ${type} is not supported`);
  const idat = [];
  let palette = null;
  let trns = null;
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IDAT') idat.push(data);
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (type === 3 && !palette) throw new Error('indexed PNG without a PLTE chunk');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is truncated');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p0 = a + b - c;
        const pa = Math.abs(p0 - a);
        const pb = Math.abs(p0 - b);
        const pc = Math.abs(p0 - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`PNG filter type ${filter} is not valid`);
      out[i] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let rgba;
    if (type === 6) rgba = [px[s], px[s + 1], px[s + 2], px[s + 3]];
    else if (type === 2) rgba = [px[s], px[s + 1], px[s + 2], 255];
    else if (type === 4) rgba = [px[s], px[s], px[s], px[s + 1]];
    else if (type === 0) rgba = [px[s], px[s], px[s], 255];
    else {
      const k = px[s];
      rgba = [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2], trns && k < trns.length ? trns[k] : 255];
    }
    data.set(rgba, i * 4);
  }
  return { width, height, data };
}

/**
 * Whether pixel (x, y) of a W×H flat tile lies inside its 2:1 diamond,
 * judged by the centre of its `cell`×`cell` art pixel. Cell 2 at 64×32 is
 * the pixel-art flats' staircase (2 px art pixels); cell 2N gives the same
 * staircase for an `@Nx` image, so imported and drawn tiles share edges.
 */
export function inDiamond(x, y, W, H, cell = 1) {
  const cx = (Math.floor(x / cell) + 0.5) * cell;
  const cy = (Math.floor(y / cell) + 0.5) * cell;
  return Math.abs(cx - W / 2) / (W / 2) + Math.abs(cy - H / 2) / (H / 2) <= 1;
}

/** Read every file of a zip (stored or deflated, no ZIP64) into a Map name → Buffer. */
export function readZip(buf) {
  let end = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 0xffff); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip central directory is corrupt');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip entry ${name}: bad local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(body));
    else if (method === 8) files.set(name, inflateRawSync(body));
    else throw new Error(`zip entry ${name}: compression method ${method} is not supported`);
  }
  return files;
}
