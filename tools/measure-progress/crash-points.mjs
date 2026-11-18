// A crash at several points across one snapshot interval (tools/measure-progress/restart.mjs). The restart section
// crashed once, at whatever point the build reached, so where the last snapshot fell before it decided the load by
// luck: on #1502, main’s snapshot fell right at that point and the branch’s 4,998 events before it, and the median
// load came out x1.50 though the log was the same size (#1512). Here the crash’s whole log is replayed through the
// branch’s own store, which snapshots by its own rule, and the folder is kept at POINTS points evenly spaced across one
// interval of INTERVAL_EVENTS events, ending at the crash itself. Each point’s load is timed, and the row judges their
// mean and their worst.

import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../server/store.mjs';

/** How many crash points. */
export const POINTS = 8;
/** One snapshot interval, in events: main’s, 5,000 events between snapshots. */
export const INTERVAL_EVENTS = 5000;

/**
 * The crash points of a log of `total` events: POINTS of them, evenly spaced across one interval, the last the crash
 * itself; or the crash alone, for a log shorter than an interval, which holds no snapshot to land before.
 * @param {number} total
 */
export function crashPoints(total) {
  if (total <= INTERVAL_EVENTS) return [total];
  const step = INTERVAL_EVENTS / POINTS;
  return Array.from({ length: POINTS }, (_, k) => total - INTERVAL_EVENTS + Math.round((k + 1) * step));
}

/** The log’s lines in a folder’s segments, in order. @param {string} dir */
function lines(dir) {
  const names = readdirSync(dir)
    .filter((n) => n.startsWith('events-'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  return names.flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean));
}

/** A folder’s snapshot and segments, copied into `to`: what a load reads, without the store’s lock. @param {string} from @param {string} to */
function copyLog(from, to) {
  mkdirSync(to, { recursive: true });
  for (const n of readdirSync(from)) if (n === 'snapshot.json' || n.startsWith('events-')) copyFileSync(join(from, n), join(to, n));
}

/**
 * Replays the whole log in `whole` through this checkout’s store, flushing each line so the store snapshots where its
 * own rule says, and keeps a copy of its folder at each point. Returns the folders, in the points’ order.
 * @param {string} whole  a folder with the crash’s whole log, no snapshot @param {string} dir  where the copies go
 * @param {number[]} points  events at which to keep the folder, ascending
 * @param {{ snapshotEvery?: number }} [options]  the store’s, which a test shortens
 */
export async function crashFolders(whole, dir, points, options = {}) {
  const work = `${dir}-replay`;
  const store = await new Store(work, options).load();
  const folders = [];
  let events = 0;
  let next = 0;
  for (const line of lines(whole)) {
    if (next >= points.length) break;
    const parsed = JSON.parse(line);
    const group = Array.isArray(parsed) ? parsed : [parsed];
    if (group.length > 1) await store.commit(group.map(({ type, data }) => ({ type, data })));
    else store.emit(group[0].type, group[0].data);
    events += group.length;
    await store.flush();
    while (next < points.length && events >= points[next]) {
      const at = `${dir}-p${next}`;
      copyLog(work, at);
      folders.push(at);
      next++;
    }
  }
  await store.close();
  return { folders, work };
}
