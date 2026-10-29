// What the store tells the rest of Postbox when it can’t be written (#508’s requirements, ST-3; design 6.6, decision 7):
// its watchers hear each time writes close or reopen, or the status the page shows changes, and Retry, from the page’s
// status line, asks it to try now (server/store-recover.mjs, retry).
//
// Watchers: the runtime stops running turns and holds new ones while writes are closed (server/store-outage.mjs), and
// the server sends the page its status line (server/index.mjs).

/** Tells watchers once per change of writability or status. @param {import('./store.mjs').Store} store */
export function changed(store) {
  if (store.closed) return;
  const writable = store.writable;
  const status = store.status;
  const key = `${writable}${JSON.stringify(status)}`;
  if (key === store.seen) return;
  store.seen = key;
  for (const fn of store.watchers) fn(writable, status);
}

/**
 * Takes a connection to the child: writes close the moment it drops.
 * @param {import('./store.mjs').Store} store @param {import('./redis-client.mjs').RedisClient} c
 */
export function attach(store, c) {
  store.client = c;
  c.ondrop = () => changed(store);
}
