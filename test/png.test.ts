import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { decodePng, encodePng, inDiamond, png, pngSize, readZip } from '../art/png.mjs';

// art/png.mjs: the node:zlib-only PNG and zip code behind scripts/import-art.mjs.

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A raw chunk (the CRC is not checked by the decoder, so zeros do). */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
}

/** A PNG with the given colour type and already filtered rows (filter byte first). */
function rawPng(w: number, h: number, type: number, rows: number[][], extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = type;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))]);
}

test('png: RGBA encode → decode round-trips, deterministically, as 8-bit RGBA', () => {
  const data = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
  const a = encodePng({ width: 3, height: 2, data });
  assert.deepEqual(encodePng({ width: 3, height: 2, data }), a);
  assert.deepEqual(pngSize(a), { width: 3, height: 2 });
  assert.equal(a[24], 8);
  assert.equal(a[25], 6);
  assert.equal(a[28], 0);
  const d = decodePng(a);
  assert.deepEqual([d.width, d.height], [3, 2]);
  assert.deepEqual([...d.data], [...data]);
  const rgb = decodePng(png(2, 1, new Uint8Array([1, 2, 3, 4, 5, 6])));
  assert.deepEqual([...rgb.data], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('png: decodes the five filters', () => {
  // A 2×5 greyscale image, all rows the same, each with a different filter: 10, 20.
  const rows = [
    [0, 10, 20], // none
    [1, 10, 10], // sub: 10, 10+10
    [2, 0, 0], // up
    [3, 5, 5], // average: 5 + (0+10)/2, 5 + (10+20)/2
    [4, 0, 0], // Paeth: picks up
  ];
  const d = decodePng(rawPng(2, 5, 0, rows));
  for (let y = 0; y < 5; y++) assert.deepEqual([...d.data.subarray(y * 8, y * 8 + 8)], [10, 10, 10, 255, 20, 20, 20, 255], `row ${y}`);
});

test('png: decodes grey+alpha, RGB, and indexed with tRNS', () => {
  assert.deepEqual([...decodePng(rawPng(1, 1, 4, [[0, 50, 128]])).data], [50, 50, 50, 128]);
  assert.deepEqual([...decodePng(rawPng(1, 1, 2, [[0, 1, 2, 3]])).data], [1, 2, 3, 255]);
  const plte = chunk('PLTE', Buffer.from([9, 8, 7, 6, 5, 4]));
  const trns = chunk('tRNS', Buffer.from([0]));
  assert.deepEqual([...decodePng(rawPng(2, 1, 3, [[0, 0, 1]], [plte, trns])).data], [9, 8, 7, 0, 6, 5, 4, 255]);
});

test('png: rejects what it does not support', () => {
  const bad = rawPng(1, 1, 0, [[0, 0]]);
  bad[24] = 16;
  assert.throws(() => decodePng(bad), /bit depth 16/);
  const interlaced = rawPng(1, 1, 0, [[0, 0]]);
  interlaced[28] = 1;
  assert.throws(() => decodePng(interlaced), /interlaced/);
  assert.throws(() => decodePng(rawPng(1, 1, 0, [[7, 0]])), /filter type 7/);
  assert.throws(() => pngSize(Buffer.from('GIF89a and more bytes to read')), /not a PNG/);
});

/** A zip of stored (method 0) and deflated (method 8) entries. */
function zip(entries: [string, Buffer, number][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body, method] of entries) {
    const data = method === 8 ? deflateRawSync(body) : body;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('zip: reads stored and deflated entries, rejects other methods', () => {
  const text = Buffer.from('hello hello hello hello');
  const files = readZip(zip([['a/stored.txt', text, 0], ['a/deflated.txt', text, 8]]));
  assert.deepEqual([...files.keys()], ['a/stored.txt', 'a/deflated.txt']);
  assert.equal(files.get('a/stored.txt')!.toString(), text.toString());
  assert.equal(files.get('a/deflated.txt')!.toString(), text.toString());
  assert.throws(() => readZip(zip([['x', text, 12]])), /x: compression method 12/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, not even close')), /not a zip/);
});

test('diamond mask: the 64×32 staircase is exactly the pixel-art flats’ (packs/town/assets/road.svg)', () => {
  const svg = readFileSync('packs/town/assets/road.svg', 'utf8');
  const covered = new Set<string>();
  for (const [, x, y, w, h] of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g))
    for (let j = Number(y); j < Number(y) + Number(h); j++) for (let i = Number(x); i < Number(x) + Number(w); i++) covered.add(`${i},${j}`);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) assert.equal(inDiamond(x, y, 64, 32, 2), covered.has(`${x},${y}`), `pixel (${x}, ${y})`);
  // At @2x (4 px art pixels) the 128×64 mask is the same staircase, doubled.
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 128; x++) assert.equal(inDiamond(x, y, 128, 64, 4), inDiamond(x >> 1, y >> 1, 64, 32, 2), `@2x pixel (${x}, ${y})`);
});
