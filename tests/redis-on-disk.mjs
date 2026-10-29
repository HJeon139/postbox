// Waits until the store’s Redis has written what it acknowledged to its append-only file, for tests that kill the
// child (tests/store-outage.test.mjs, tests/browser/store-status.spec.mjs). With appendfsync everysec, Redis holds that
// write back while a background fsync runs, for up to 2 s, so a SIGKILL right after a write can lose it, and the store
// then finds Redis behind it (ESEQ). Those tests are about the outage, not about that (#508’s requirements, ST-4).

/** @param {any} store  a Store on a data folder */
export async function onDisk(store) {
  const c = await store.redis.sup.client();
  try {
    for (let i = 0; i < 400; i++) {
      const info = String(await c.call('INFO', 'persistence'));
      if (/aof_buffer_length:0\r?\n/.test(info) && /aof_pending_bio_fsync:0\r?\n/.test(info)) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error('The store’s Redis didn’t write its append-only file within 10 s.');
  } finally {
    c.close();
  }
}
