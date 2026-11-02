// The pages’ live updates over server-sent events (server/index.mjs, /api/stream): each event the store applies, with
// its seq as the event id, so a browser that reconnects asks for everything after the last one it saw.
//
// A page’s place in history is its seq within a history epoch (Store.epoch; #508’s design, “Storage”): a token new at
// each load(). /api/state gives the page both, and the page echoes the epoch when its stream connects (?epoch=, or an
// X-Postbox-Epoch header for a tool) beside its Last-Event-ID. The seq alone can’t tell a tab merely behind from one on
// a lost timeline: after a restart, startup emits before any tab is back, so the seq passes the id of a tab that saw
// events the restarted store never kept, and the tab would get the backlog after its own id and keep what the store
// lost. A stream that names another epoch, or a seq past the store’s, is told to resync, whatever its seq. Event ids
// stay the plain seq, so tools reading the stream (tools/uat/history.mjs) are unchanged; the stream names its epoch in
// its first frame, which they ignore.

import { publicFrame } from './public-state.mjs';

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
    const line = publicFrame(ev);
    const epoch = store.epoch; // the history the event belongs to: a send held back past a Retry says nothing (gpt’s finding)
    const send = () => {
      if (store.epoch !== epoch) return;
      for (const res of streams) res.write(line);
    };
    if (lag > 0) setTimeout(send, lag).unref();
    else send();
  });
  // The store’s status, unnumbered, each time writes close or reopen, a Retry starts or ends, or a warning changes
  // (#508’s storage design, “When a write fails (ST-3)”): the page shows one status line from it.
  store.onStatus((status) => {
    const frame = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
    for (const res of streams) res.write(frame);
  });
  // Retry installs a new epoch: every open stream is told to load the state again.
  store.onReload(() => {
    for (const res of streams) res.write(`event: epoch\ndata: ${JSON.stringify(store.epoch)}\n\nevent: resync\ndata: {}\n\n`);
  });
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 15000);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  function stream(req, res, url) {
    const { since, lost } = place(req, url, store);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // The epoch, then the store’s status, so a page that connects or reconnects while writes are closed sees it even
    // though it missed the frame that closed them (critic’s finding on 1b).
    res.write(`retry: 1500\n\nevent: epoch\ndata: ${JSON.stringify(store.epoch)}\n\nevent: status\ndata: ${JSON.stringify(store.status)}\n\n`);
    const backlog = lost ? null : store.since(since);
    // Too far behind, or on a lost timeline: the browser refetches the whole state, then resumes from its seq.
    if (backlog === null) res.write(`event: resync\ndata: {}\n\n`);
    else for (const ev of backlog) res.write(publicFrame(ev));
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  return { streams, stop: () => clearInterval(keepAlive), stream };
}

/**
 * Where a connecting page is in history, and whether that’s a place this store never had, so it must load the state
 * again: on another epoch, whatever its seq, or ahead of the store (a restart dropped what it saw, and it would take
 * every later event for one it had seen). A page naming no epoch is served by its seq alone.
 * @param {import('node:http').IncomingMessage} req @param {URL} url @param {import('./store.mjs').Store} store
 */
function place(req, url, store) {
  const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? store.state.seq);
  const named = /** @type {string | null} */ (req.headers['x-postbox-epoch'] ?? url.searchParams.get('epoch'));
  return { since, lost: (named !== null && named !== '' && named !== store.epoch) || since > store.state.seq };
}
