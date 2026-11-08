import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** 8-bit RGBA pixels, row by row. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Larger images are refused before inflating, so a huge capture cannot occupy the CPU. */
export const MAX_PIXELS = 16 * 1024 * 1024;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes the PNGs Chrome captures: 8-bit truecolor with or without alpha, not interlaced.
 * Other PNG variants are rejected rather than misread.
 */
export function decodePng(bytes: Uint8Array): Image {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE))
    throw new TypeError('Not a PNG image');
  let width = 0,
    height = 0,
    channels = 0;
  const chunks: Buffer[] = [];
  for (let at = 8; at + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > buffer.length) throw new TypeError('Truncated PNG chunk');
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (crc32(buffer.subarray(at + 4, at + 8 + length)) !== buffer.readUInt32BE(at + 8 + length))
      throw new TypeError(`PNG chunk ${type} fails its CRC`);
    at += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
        throw new TypeError('Only 8-bit, non-interlaced RGB and RGBA PNGs are supported');
      channels = color === 6 ? 4 : 3;
      if (!width || !height || width * height > MAX_PIXELS)
        throw new RangeError(`PNG of ${width}x${height} exceeds ${MAX_PIXELS} pixels`);
    } else if (type === 'IDAT') chunks.push(body);
    else if (type === 'IEND') break;
  }
  if (!channels) throw new TypeError('PNG has no header');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new TypeError('PNG data has the wrong size');
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride),
    row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1),
      filter = raw[start]!;
    if (filter > 4) throw new TypeError(`Unknown PNG filter ${filter}`);
    for (let i = 0; i < stride; i++) {
      const x = raw[start + 1 + i]!,
        a = i >= channels ? row[i - channels]! : 0,
        b = previous[i]!,
        c = i >= channels ? previous[i - channels]! : 0;
      row[i] =
        filter === 0
          ? x
          : filter === 1
            ? x + a
            : filter === 2
              ? x + b
              : filter === 3
                ? x + ((a + b) >> 1)
                : x + paeth(a, b, c);
    }
    for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
      data[o] = row[x * channels]!;
      data[o + 1] = row[x * channels + 1]!;
      data[o + 2] = row[x * channels + 2]!;
      data[o + 3] = channels === 4 ? row[x * channels + 3]! : 255;
    }
    [previous, row] = [row, previous];
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encodes RGBA pixels as an 8-bit RGBA PNG, choosing the Up or Sub filter per row. */
export function encodePng(image: Image): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride,
      out = y * (stride + 1);
    // The filter with the smaller sum of absolute differences usually compresses better.
    let up = 0,
      sub = 0;
    for (let i = 0; i < stride; i++) {
      const value = data[row + i]!;
      const u = (value - (y ? data[row - stride + i]! : 0)) & 255;
      const s = (value - (i >= 4 ? data[row + i - 4]! : 0)) & 255;
      up += u < 128 ? u : 256 - u;
      sub += s < 128 ? s : 256 - s;
    }
    const filter = up <= sub ? 2 : 1;
    raw[out] = filter;
    for (let i = 0; i < stride; i++)
      raw[out + 1 + i] =
        data[row + i]! -
        (filter === 2 ? (y ? data[row - stride + i]! : 0) : i >= 4 ? data[row + i - 4]! : 0);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
