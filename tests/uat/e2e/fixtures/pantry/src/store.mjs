import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const FILE = 'data/pantry.json';
let queue = Promise.resolve();

export async function readAll() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Changes the list one write at a time: each waits for the one before it, reads the file fresh, and replaces it
 * through a temporary file, so two adds at once can’t lose one another and a crash never leaves half a file.
 */
export function write(change) {
  const next = queue.then(async () => {
    const items = change(await readAll());
    await mkdir('data', { recursive: true });
    await writeFile(`${FILE}.tmp`, JSON.stringify(items, null, 2));
    await rename(`${FILE}.tmp`, FILE);
    return items;
  });
  queue = next.catch(() => {});
  return next;
}
