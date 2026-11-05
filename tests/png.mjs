// A valid greyscale PNG of any size, built in code, for specs that need an image a browser draws (#780). Its rows are
// all one grey, so even a large one compresses to a small file.

import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A width × height PNG in one grey, padded with a tEXt chunk of `pad` bytes when it’s over 0. */
export function png(width = 4, height = 3, pad = 0, grey = 0x80) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const row = Buffer.alloc(1 + width, grey);
  row[0] = 0; // no filter
  const idat = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const extra = pad > 0 ? [chunk('tEXt', Buffer.alloc(pad, 0x41))] : [];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
