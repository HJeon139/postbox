// Reads of the whole list are cached for 30 seconds; a write forgets the entry, so the next read goes to the file.
const entries = new Map();
const TTL = 30_000;

export async function cached(key, load) {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await load();
  entries.set(key, { value, at: Date.now() });
  return value;
}

export function forget(key) {
  entries.delete(key);
}
