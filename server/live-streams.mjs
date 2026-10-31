// The pages’ live updates over server-sent events (server/index.mjs, /api/stream): each event the store applies, with
// its seq as the event id, so a browser that reconnects asks for everything after the last one it saw.

/**
 * Sends the store’s events to every open stream, and a keep-alive every 15 s; stream() opens one for a request to
 * /api/stream.
 * @param {import('./store.mjs').Store} store
 * @returns {{
 *   streams: Set<import('node:http').ServerResponse>,
 *   stop: () => void,
 *   stream: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => void,
 * }}
 */
export function liveStreams(store) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  // POSTBOX_STREAM_LAG holds every event back that many milliseconds, as a busy computer can. The browser specs run
  // with it in CI to show they wait for the page to hear a change, not for a fixed time.
  const lag = Number(process.env.POSTBOX_STREAM_LAG) || 0;
  store.subscribe((ev) => {
    const line = `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
    const send = () => {
      for (const res of streams) res.write(line);
    };
    if (lag > 0) setTimeout(send, lag).unref();
    else send();
  });
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 15000);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  function stream(req, res, url) {
    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? store.state.seq);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1500\n\n');
    const backlog = store.since(since);
    // Too far behind: the browser refetches the whole state, then resumes from its sequence number.
    if (backlog === null) res.write(`event: resync\ndata: {}\n\n`);
    else for (const ev of backlog) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  return { streams, stop: () => clearInterval(keepAlive), stream };
}
