// A gzipped ustar archive made in memory, shaped as the build workflow’s `tar --format ustar -czf` writes one
// (.github/workflows/redis.yml, “Archive it”), for the tests of what unpacks it (tests/redis-unpack.test.mjs) and of the
// CI tool that verifies it first (tests/redis-ci.test.mjs).

import { gzipSync } from 'node:zlib';

/**
 * A gzipped ustar archive, as `tar --format ustar -czf` writes one.
 * @param {{ name: string, type?: string, body?: string, mode?: number, link?: string }[]} entries
 */
export function tarOf(entries) {
  const blocks = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
