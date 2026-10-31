// The pages’ live updates over server-sent events (server/index.mjs, /api/stream): each event the store applies, with
// its seq, and the store’s status line, unnumbered, each time writes close or reopen (#508’s requirements, ST-3), so
// every open page says why it can’t save and when it can again.
//
// A page’s place in history is its seq within a history epoch (Store.epoch): the token of the readback of Redis the
// store runs on, new at a restart’s load and at a repair’s reload. /api/state gives the page both, and the page echoes
// the epoch when its stream connects (?epoch=, or an X-Postbox-Epoch header for a tool) beside its Last-Event-ID. The
// seq alone can’t tell a tab merely behind from one on a lost timeline: after a restart, startup emits before any tab
// is back (the “Interrupted by a restart” patches, expiries), so the seq passes the id of a tab that held optimistic
// events Redis never took, and the tab would get the backlog after its own id and keep what the store lost; a
// repair’s reload can drop an event and leave the seq where it was (#567). A stream that names another epoch is told
// to resync, whatever its seq. Event ids stay the plain seq, so tools reading the stream (tools/uat/history.mjs) are
// unchanged; the stream names its epoch in its first frame, which they ignore.

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
  // A replacement invalidates history already being read, even if its sequence number stays the same.
  let replacements = 0;
  store.reloads?.add(() => {
    replacements++;
    out('event: resync\ndata: {}\n\n');
  });
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 15000);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  async function stream(req, res, url) {
    const before = replacements;
    const epoch = store.epoch;
    const { since, lost } = place(req, url, store);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 1500\n\n${storeLine(store.status)}`);
    let backlog = lost ? null : await store.backlog(since); // from memory, or after a restart from the store’s events stream
    // The replacement’s broadcast reached only existing streams. This page must load the new state too.
    if (before !== replacements || store.epoch !== epoch) backlog = null;
    // The read of the events stream awaited Redis, and an emit meanwhile reached only the streams already open: what
    // the store applied since the backlog ends is in memory, taken here, in the same tick that adds this stream, so
    // the emit reaches it exactly once and after the backlog.
    if (backlog !== null) {
      const more = store.since(backlog.at(-1)?.seq ?? since);
      backlog = more === null ? null : [...backlog, ...more];
    }
    // The status may have changed while the backlog was read, and its line reached only the streams open then: it’s
    // sent again here, before the backlog, in this same tick (gpt’s r2 review of #553, blocker 2).
    res.write(storeLine(store.status));
    res.write(`event: epoch\ndata: ${JSON.stringify(store.epoch ?? null)}\n\n`);
    // Too far behind: the browser refetches the whole state, then resumes from its sequence number.
    if (backlog === null) res.write(`event: resync\ndata: {}\n\n`);
    else for (const ev of backlog) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  return { streams, stop: () => clearInterval(keepAlive), stream };
}

/**
 * Where a connecting page is in history, and whether that’s a place this store never had, so it must load the state
 * again: ahead of the store (an emit is broadcast before Redis acknowledges it, and a restart reads back Redis without
 * what it didn’t take, server/store-write.mjs, so the browser would drop every later event as one it had seen; #553’s
 * review, blocker 3), or on another epoch, whatever its seq. A page naming no epoch is served by its seq alone.
 * @param {import('node:http').IncomingMessage} req @param {URL} url @param {import('./store.mjs').Store} store
 */
function place(req, url, store) {
  const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? store.state.seq);
  const named = /** @type {string | null} */ (req.headers['x-postbox-epoch'] ?? url.searchParams.get('epoch'));
  return { since, lost: (named !== null && named !== '' && named !== store.epoch) || since > store.state.seq };
}

/** The store’s status as a server-sent event: running, or down with its cause. @param {any} status */
export const storeLine = (status) => `event: store\ndata: ${JSON.stringify(status)}\n\n`;
