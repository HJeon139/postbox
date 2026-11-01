// Recovery on load (server/store.mjs; #508’s storage design, “Recovery on load”): the log segments after the snapshot
// are read in order, and each line (shared/log-lines.mjs: one event, or a commit’s array) is applied above the state’s
// seq. What a damaged line means:
//
// - A fragment WITHOUT its newline at the end of the LAST segment never finished: the writer puts a line and its newline
//   in one write and acknowledges nothing before the fsync, so it’s cut off, whether or not it parses, and warned about.
// - A newline-terminated line that doesn’t parse, or a malformed group (an empty array, an event without an integer
//   seq, seqs that aren’t consecutive, a group across the snapshot’s seq), is damaged acknowledged history: load()
//   REFUSES, naming the file and the line, even when it’s the last line, rather than dropping it or what follows. So
//   does a fragment in any segment but the last.
// - A GAP in seq, against the applied seq (a segment’s first lines are often ones the snapshot already holds, and are
//   skipped): acknowledged history was lost, and refusing wouldn’t bring it back, so the store starts, warns, and keeps
//   the range as `store.lost` for the status line (PR 1b).
// A commit whose seqs are all applied is skipped whole, and a commit’s opId is remembered for a retry (store.ops).

import { eventsOf } from '../shared/log-lines.mjs';
import { apply } from '../shared/state.mjs';

/** Replays the segments after the snapshot, in order, leaving the writer at the end of the last. @param {import('./store-recover.mjs').Candidate} store */
export async function replay(store) {
  const segs = await store.segments();
  for (const [i, seg] of segs.entries()) await replaySegment(store, seg, i === segs.length - 1);
}

/** @param {import('./store-recover.mjs').Candidate} store @param {{ name: string }} seg @param {boolean} last */
async function replaySegment(store, seg, last) {
  const path = store.at(seg.name);
  const text = await store.io.readFile(path, 'utf8');
  const lines = text.split('\n'); // the text after the final newline: empty when the file ends in one
  let offset = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.trim()) {
      if (n === lines.length - 1) {
        if (!last) throw refusal(seg, n, offset, 'has no newline, so its write never finished, and a later segment follows it');
        await store.io.truncate(path, offset);
        console.warn(`Dropped an incomplete event at the end of ${seg.name} (the server stopped mid-write).`);
        break;
      }
      let events;
      try {
        events = eventsOf(line);
      } catch (e) {
        throw refusal(seg, n, offset, `isn’t valid JSON (${e.message})`);
      }
      const bad = malformed(events);
      if (bad) throw refusal(seg, n, offset, bad);
      applyGroup(store, events, seg, n, offset);
    }
    offset += Buffer.byteLength(line) + 1;
  }
}

/** The error load() rejects with for a damaged line, naming the file, the line and its byte offset. */
function refusal(seg, n, offset, why) {
  return new Error(
    `Couldn’t load the event log: line ${n + 1} of ${seg.name} (byte ${offset}) ${why}. Postbox won’t drop it or what follows; repair the line or move the file aside.`,
  );
}

/** Why a line’s events can’t be a commit, or null when they can: a nonempty group of typed events with consecutive integer seqs. */
function malformed(events) {
  if (!events.length) return 'is an empty commit';
  for (const [i, ev] of events.entries()) {
    if (!ev || typeof ev !== 'object' || !Number.isInteger(ev.seq) || typeof ev.type !== 'string')
      return `holds something that isn’t an event with an integer seq and a type (event ${i + 1})`;
    if (i && ev.seq !== events[i - 1].seq + 1) return `holds events whose seqs aren’t consecutive (${events[i - 1].seq} then ${ev.seq})`;
  }
  return null;
}

/** Applies a well-formed group above the state’s seq: skipped whole when the snapshot has it, refused when it straddles the snapshot. */
function applyGroup(store, events, seg, n, offset) {
  const first = events[0].seq;
  const end = events[events.length - 1].seq;
  if (end <= store.state.seq) return;
  if (first <= store.state.seq)
    throw refusal(seg, n, offset, `holds seqs ${first} to ${end}, across the snapshot’s ${store.state.seq}: a commit can’t be applied in part`);
  if (first > store.state.seq + 1) noteGap(store, store.state.seq + 1, first - 1, seg, n);
  for (const ev of events) {
    apply(store.state, ev.type, ev.data);
    store.state.seq = ev.seq;
    store.sinceSnapshot++;
  }
  if (events[0].op !== undefined) store.ops.set(events[0].op, end); // the last seq, as a commit resolves
}

/** Records lost history (seqs `from` to `to`, acknowledged once and gone) on the store, and warns. */
function noteGap(store, from, to, seg, n) {
  const count = to - from + 1;
  const lost = store.lost ?? { from, to, count: 0 };
  store.lost = { from: Math.min(lost.from, from), to: Math.max(lost.to, to), count: lost.count + count };
  console.warn(`The event log lost events ${from} to ${to} (${count}) before line ${n + 1} of ${seg.name}. Postbox starts without them.`);
}
