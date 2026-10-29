// The pages’ live updates over server-sent events (server/index.mjs, /api/stream): each event the store applies, with
// its seq, and the store’s status line, unnumbered, each time writes close or reopen (#508’s requirements, ST-3), so
// every open page says why it can’t save and when it can again.

/**
 * Sends the store’s events and status to every open stream, and a keep-alive every 15 s.
 * @param {import('./store.mjs').Store} store
 * @returns {{ streams: Set<import('node:http').ServerResponse>, stop: () => void }}
 */
export function liveStreams(store) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  // POSTBOX_STREAM_LAG holds every event back that many milliseconds, as a busy computer can. The browser specs run
  // with it in CI to show they wait for the page to hear a change, not for a fixed time.
  const lag = Number(process.env.POSTBOX_STREAM_LAG) || 0;
  /** @param {string} line */
  const out = (line) => {
    const send = () => {
      for (const res of streams) res.write(line);
    };
    if (lag > 0) setTimeout(send, lag).unref();
    else send();
  };
  store.subscribe((ev) => out(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`));
  store.watchers.add((_writable, status) => out(storeLine(status)));
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 15000);
  return { streams, stop: () => clearInterval(keepAlive) };
}

/** The store’s status as a server-sent event: running, or down with its cause. @param {any} status */
export const storeLine = (status) => `event: store\ndata: ${JSON.stringify(status)}\n\n`;
