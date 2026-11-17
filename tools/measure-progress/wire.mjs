// What reaches a page on the wire (tools/measure-progress.mjs): tabs on the store’s real event stream
// (server/live-streams.mjs, through server/public-state.mjs’s publicFrame), each with a conversation open, counting
// the bytes and frames it’s sent. The keep-alive comments are counted apart, since they come on a timer, not with work.

import { liveStreams } from '../../server/live-streams.mjs';

/**
 * A tab on a stream, with `open` as its open conversations, connecting after `since`: it counts the bytes and frames
 * it’s sent, what the connect sends included. @param {any} ls liveStreams()’s @param {any} store
 * @param {string[]} open @param {number} since
 */
export function tabOn(ls, store, open, since) {
  const tab = { bytes: 0, frames: 0, keepAlive: 0 };
  const res = {
    writeHead() {},
    /** @param {string} s */
    write(s) {
      if (s.startsWith(': keep-alive')) tab.keepAlive++;
      else {
        tab.bytes += Buffer.byteLength(s);
        tab.frames += (s.match(/\n\n/g) ?? []).length;
      }
      return true;
    },
    destroy() {},
    once() {},
  };
  const req = { headers: {}, on() {} };
  const url = new URL(`http://127.0.0.1/api/stream?since=${since}&epoch=${encodeURIComponent(store.epoch)}&open=${open.join(',')}`);
  ls.stream(/** @type {any} */ (req), /** @type {any} */ (res), url);
  return tab;
}

/**
 * Opens `n` tabs on the store’s stream, each with `open` as its open conversations, from the store’s seq now, and
 * counts from there: what a connect sends before any work isn’t the work’s. Returns the stream too, for tabs that join
 * later. @param {any} store @param {number} n @param {string[]} open
 */
export function openTabs(store, n, open) {
  const ls = liveStreams(store);
  const tabs = Array.from({ length: n }, () => {
    const tab = tabOn(ls, store, open, store.state.seq);
    tab.bytes = 0;
    tab.frames = 0;
    return tab;
  });
  return { tabs, ls, stop: () => ls.stop() };
}
