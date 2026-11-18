// What reaches a page on the wire (tools/measure-progress.mjs): tabs on the store’s real event stream
// (server/live-streams.mjs, through server/public-state.mjs’s publicFrame), each with a conversation open, counting
// the bytes and frames it’s sent. The keep-alive comments are counted apart, since they come on a timer, not with work.

import { liveStreams } from '../../server/live-streams.mjs';

/**
 * A tab on a stream, with `open` as its open conversations, connecting after `since`. What the connect sends (the
 * stream’s first frames, the backlog, and the running turns’ live snapshot) is counted apart from what comes after,
 * and the snapshot’s `live` frames apart within it. @param {any} ls liveStreams()’s @param {any} store
 * @param {string[]} open @param {number} since
 */
export function tabOn(ls, store, open, since) {
  const tab = { bytes: 0, frames: 0, keepAlive: 0, connectBytes: 0, connectFrames: 0, snapshotBytes: 0, snapshotFrames: 0 };
  let connecting = true;
  const res = {
    writeHead() {},
    /** @param {string} s */
    write(s) {
      if (s.startsWith(': keep-alive')) {
        tab.keepAlive++;
        return true;
      }
      for (const frame of s.split('\n\n').slice(0, -1)) {
        const bytes = Buffer.byteLength(frame) + 2;
        if (!connecting) {
          tab.bytes += bytes;
          tab.frames++;
          continue;
        }
        tab.connectBytes += bytes;
        tab.connectFrames++;
        if (frame.startsWith('event: live\n')) {
          tab.snapshotBytes += bytes;
          tab.snapshotFrames++;
        }
      }
      return true;
    },
    destroy() {},
    once() {},
  };
  const req = { headers: {}, on() {} };
  const url = new URL(`http://127.0.0.1/api/stream?since=${since}&epoch=${encodeURIComponent(store.epoch)}&open=${open.join(',')}`);
  ls.stream(/** @type {any} */ (req), /** @type {any} */ (res), url);
  connecting = false;
  return tab;
}

/**
 * Opens `n` tabs on the store’s stream, each with `open` as its open conversations, from the store’s seq now; their
 * bytes and frames are what came after the connect, the work’s. Returns the stream too, for tabs that join
 * later. The stream is told the runtime’s running turns, as server/index.mjs tells it, so a tab that connects
 * mid-turn gets their live snapshot where Postbox sends one (#1471); without, it reported none.
 * @param {any} store @param {number} n @param {string[]} open @param {any} [running]  the runtime’s rt.running
 * @param {typeof liveStreams} [streams]
 */
export function openTabs(store, n, open, running = undefined, streams = liveStreams) {
  const ls = /** @type {any} */ (streams)(store, undefined, /** @type {any} */ ({ running }));
  const tabs = Array.from({ length: n }, () => tabOn(ls, store, open, store.state.seq));
  return { tabs, ls, stop: () => ls.stop() };
}
