// The pages’ live updates over server-sent events (server/index.mjs, /api/stream): each event the store applies, with
// its seq, and the store’s status line, unnumbered, each time writes close or reopen (#508’s requirements, ST-3), so
// every open page says why it can’t save and when it can again.

/**
 * Sends the store’s events and status to every open stream, and a keep-alive every 15 s; stream() opens one for a
 * request to /api/stream.
 * @param {import('./store.mjs').Store} store
 * @returns {{
 *   streams: Set<import('node:http').ServerResponse>,
 *   stop: () => void,
 *   stream: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<void>,
 * }}
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

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  async function stream(req, res, url) {
    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? store.state.seq);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 1500\n\n${storeLine(store.status)}`);
    const backlog = await store.backlog(since); // from memory, or after a restart from the store’s events stream
    // Too far behind: the browser refetches the whole state, then resumes from its sequence number.
    if (backlog === null) res.write(`event: resync\ndata: {}\n\n`);
    else for (const ev of backlog) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  return { streams, stop: () => clearInterval(keepAlive), stream };
}

/** The store’s status as a server-sent event: running, or down with its cause. @param {any} status */
export const storeLine = (status) => `event: store\ndata: ${JSON.stringify(status)}\n\n`;
