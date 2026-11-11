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
//
// Every event frame is built from the event’s public form (server/public-state.mjs): a type the page may not see goes
// out as a cursor with its seq. The control frames’ names are shared/state.mjs’s STREAM, which no event type may take.

import { EVENTS, STREAM } from '../shared/state.mjs';
import { publicFrame, publicHeaderFrame } from './public-state.mjs';
import { REJECTED } from './store-reject.mjs';
import { threadHeaders } from './thread-headers.mjs';

/**
 * How long a stream’s page may go without reading before the stream is closed (#1210). Every frame for it waits in its
 * response, on the heap, until the page reads; a tab the browser froze in the background never does. Closed, the page’s
 * EventSource reconnects when it runs again, with its Last-Event-ID, and gets what it missed, or loads the state again.
 */
export const UNREAD_MS = 60_000;

/**
 * Sends the store’s events to every open stream, and a keep-alive every 15 s; stream() opens one for a request to
 * /api/stream.
 * @param {import('./store.mjs').Store} store
 * @param {typeof EVENTS} [events]  the event table, which a spec replaces to show a private type
 * @param {{ now?: () => number }} [options]  the clock UNREAD_MS is measured on, which a test sets
 * @returns {{
 *   streams: Set<import('node:http').ServerResponse>,
 *   stop: () => void,
 *   stream: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => void,
 *   headers: ReturnType<typeof threadHeaders>,
 * }}
 */
export function liveStreams(store, events = EVENTS, { now = Date.now } = {}) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  const deliver = frameWriter(streams, now);
  // Each thread’s header facts (#1155): /api/state carries them, and each change follows its event as a header frame.
  const headers = threadHeaders(store);
  /** The conversations each page’s stream has open (#1155); a tool’s stream names none and gets every item event. */
  const openOf = new WeakMap();
  store.subscribe(eventSender({ store, streams, deliver, headers, events, openOf }));
  // The store’s status, unnumbered, each time writes close or reopen, a Retry starts or ends, or a warning changes
  // (#508’s storage design, “When a write fails (ST-3)”): the page shows one status line from it.
  store.onStatus((status) => {
    const frame = `event: ${STREAM.status}\ndata: ${JSON.stringify(status)}\n\n`;
    for (const res of streams) deliver(res, frame);
  });
  // Retry installs a new epoch: every open stream is told to load the state again.
  store.onReload(() => {
    headers.clear();
    for (const res of streams) deliver(res, `event: ${STREAM.epoch}\ndata: ${JSON.stringify(store.epoch)}\n\nevent: ${STREAM.resync}\ndata: {}\n\n`);
  });
  const keepAlive = setInterval(() => {
    for (const res of streams) deliver(res, ': keep-alive\n\n');
  }, 15000);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  function stream(req, res, url) {
    const { since, lost } = place(req, url, store);
    const open = openNamed(url);
    if (open) openOf.set(res, open);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // The epoch, then the store’s status, so a page that connects or reconnects while writes are closed sees it even
    // though it missed the frame that closed them (critic’s finding on 1b).
    res.write(
      `retry: 1500\n\nevent: ${STREAM.epoch}\ndata: ${JSON.stringify(store.epoch)}\n\nevent: ${STREAM.status}\ndata: ${JSON.stringify(store.status)}\n\n`,
    );
    const backlog = lost ? null : store.since(since);
    // Too far behind, or on a lost timeline: the browser refetches the whole state, then resumes from its seq.
    if (backlog === null) res.write(`event: ${STREAM.resync}\ndata: {}\n\n`);
    else for (const frame of backlogFrames(backlog, since, events, headers, open)) deliver(res, frame);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  return { streams, stop: () => clearInterval(keepAlive), stream, headers };
}

/**
 * What the store tells the streams of each event: its frame, as each page’s open conversations let it see the event,
 * then the header frames it changed.
 * @param {{ store: any, streams: Set<import('node:http').ServerResponse>, deliver: (res: any, frame: string) => void,
 *   headers: ReturnType<typeof threadHeaders>, events: typeof EVENTS, openOf: WeakMap<object, Set<string>> }} o
 */
function eventSender({ store, streams, deliver, headers, events, openOf }) {
  // POSTBOX_STREAM_LAG holds every event back that many milliseconds, as a busy computer can. The browser specs run
  // with it in CI to show they wait for the page to hear a change, not for a fixed time.
  const lag = Number(process.env.POSTBOX_STREAM_LAG) || 0;
  return (/** @type {any} */ ev) => {
    // A rejected event may have changed the state unseen: the headers are counted again, and the page loads them anew.
    if (ev.type === REJECTED) headers.clear();
    const changed = ev.type === REJECTED ? [] : headers.note(ev);
    // A header is counted from the thread's items: one after an event the page may not see would tell it what changed.
    const after = Object.hasOwn(events, ev.type) && events[ev.type].public ? headerFrames(changed) : '';
    const epoch = store.epoch; // the history the event belongs to: a send held back past a Retry says nothing (gpt’s finding)
    // An event the store held as rejected (#609): its place, then a resync, since a handler that broke its contract
    // may have changed the state the page can't see.
    const tail = ev.type === REJECTED ? `${after}event: ${STREAM.resync}\ndata: {}\n\n` : after;
    // Both forms now, as the event is: a send held back would otherwise read the store's objects as they are by then.
    const full = publicFrame(ev, events) + tail;
    const shut = publicFrame(ev, events, new Set()) + tail; // as a page sees it that hasn't its conversation open
    const send = () => {
      if (store.epoch !== epoch) return;
      for (const res of streams) {
        const open = openOf.get(res);
        deliver(res, !open || open.has(ev.data?.threadId) ? full : shut);
      }
    };
    if (lag > 0) setTimeout(send, lag).unref();
    else send();
  };
}

/** The most conversations one stream can name as open: a pane and a side panel, with room to spare. */
const MOST_OPEN = 16;

/**
 * The conversations a page’s stream names as open (?open=a,b), or null for a stream that names none, as a tool’s.
 * @param {URL} url
 */
function openNamed(url) {
  const named = url.searchParams.get('open');
  return named === null ? null : new Set(named.split(',').filter(Boolean).slice(0, MOST_OPEN));
}

/**
 * What a page that connects after `since` missed: each event’s public frame, then the headers that changed meanwhile, as
 * they are now. @param {any[]} backlog @param {number} since @param {typeof EVENTS} events
 * @param {ReturnType<typeof threadHeaders>} headers @param {Set<string> | null} open
 */
function backlogFrames(backlog, since, events, headers, open) {
  const frames = backlog.map((ev) => publicFrame(ev, events, open));
  const changed = headerFrames(headers.changedSince(since));
  return changed ? [...frames, changed] : frames;
}

/**
 * The header frames for these headers: each as it is now, or null for a thread that was removed.
 * @param {{ threadId: string, header: any }[]} changed
 */
function headerFrames(changed) {
  return changed.map(({ threadId, header }) => publicHeaderFrame(threadId, header)).join('');
}

/**
 * Writes frames to the streams, and closes a stream instead once its page hasn’t read for UNREAD_MS: since its first
 * write past the buffer’s mark, with no drain after it.
 * @param {Set<import('node:http').ServerResponse>} streams @param {() => number} now
 * @returns {(res: import('node:http').ServerResponse, frame: string) => void}
 */
function frameWriter(streams, now) {
  /** When each stream’s page fell behind. */
  const behindSince = new WeakMap();
  return (res, frame) => {
    const since = behindSince.get(res);
    if (since !== undefined && now() - since >= UNREAD_MS) {
      streams.delete(res);
      res.destroy();
      return;
    }
    if (res.write(frame) !== false || since !== undefined) return;
    behindSince.set(res, now());
    res.once('drain', () => behindSince.delete(res));
  };
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
