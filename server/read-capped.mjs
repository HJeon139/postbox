import { open } from 'node:fs/promises';

/**
 * Reads a file, but never more than max bytes of it: null when it has more. Its size was checked before, but a file
 * that’s still being written can grow after that, so the read itself stops past the limit.
 * @param {string} path @param {number} max
 */
export async function readCapped(path, max) {
  const fh = await open(path, 'r');
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      // One byte past the limit is enough to know it’s over.
      const chunk = Buffer.alloc(Math.min(1024 * 1024, max + 1 - total));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) return null;
    }
    return Buffer.concat(chunks, total);
  } finally {
    await fh.close();
  }
}
