// Writes ATIF v1.8 trajectories (tools/atif.mjs) from a recorded Postbox event stream, outside a UAT run too, so a
// harness that records /api/stream (Track A’s recorder) can reuse it:
//
//   node tools/atif-export.mjs <recording> [--session <id> | --agent <handle>] [--out <folder>]
//
// <recording> is one of:
// - a JSON Lines file of events as /api/stream sends them ({ seq, type, data }, one per line, or a commit’s array),
//   with a live.jsonl beside it read for the steps’ input and output, if there is one;
// - a UAT run’s folder, which holds events.jsonl and live.jsonl (tools/uat/history.mjs, writeHistory);
// - a Postbox data folder, or a folder with one in `data/`: its snapshot.json, then its log segments in order. The
//   store deletes a segment once a snapshot covers it, so what came before the snapshot is each item as it ended
//   there, and the trajectory’s notes say so.
// Each trajectory goes to <out>/<handle>-<session>.atif.json; with no --out and one trajectory, to standard output.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshotText } from '../server/store-snapshot-lines.mjs';
import { EVENTS } from '../shared/state.mjs';
import { trajectories } from './atif.mjs';
import { lines } from './uat/history.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Postbox’s version, as each trajectory’s agent.version. */
export const POSTBOX_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** The JSON Lines in a file, or none when it isn’t there. @param {string} file */
const linesIn = (file) => (existsSync(file) ? lines(readFileSync(file, 'utf8')) : []);

/** The work ledger’s entries the trajectories read: turns, and the calls that keep their arguments. */
const WORK_KINDS = new Set(['turn', 'command', 'external', 'read']);

/**
 * A data folder’s snapshot as events placed before the log’s: each session, each item as it ended, the work ledger’s
 * turns and calls, each inbox’s entries, and each clock as it stood. @param {Record<string, any>} snap
 */
function snapshotEvents(snap) {
  const out = [];
  for (const se of Object.values(snap.sessions ?? {})) out.push({ type: 'session', data: se });
  for (const [threadId, list] of Object.entries(snap.items ?? {})) for (const item of list) out.push({ type: 'item.add', data: { threadId, item } });
  for (const [convId, list] of Object.entries(snap.work ?? {}))
    for (const entry of list) if (WORK_KINDS.has(entry?.kind)) out.push({ type: 'work.add', data: { convId, entry } });
  for (const [sessionId, list] of Object.entries(snap.inbox ?? {})) for (const entry of list) out.push({ type: 'entry.put', data: { sessionId, entry } });
  for (const c of Object.values(snap.clocks ?? {})) {
    out.push({ type: 'clock.started', data: { sessionId: c.sessionId, threadId: c.threadId, budgetMs: c.budgetMs, at: c.startedAt } });
    if (c.state === 'expired')
      out.push({ type: 'clock.expired', data: { sessionId: c.sessionId, elapsedMs: c.budgetMs, budgetMs: c.budgetMs, at: c.expiredAt } });
  }
  // Before every event of the log, in this order; items by their time across threads, as the conversation showed them.
  out.sort((a, b) => timeOf(a) - timeOf(b));
  return out.map((e, i) => ({ seq: i - out.length, ...e }));
}

/** When a snapshot’s event happened, for its order. @param {any} e */
const timeOf = (e) => e.data.item?.at ?? e.data.entry?.startedAt ?? e.data.entry?.at ?? e.data.at ?? e.data.startedAt ?? 0;

/**
 * The events and live frames of a recording, and a note on what they leave out.
 * @param {string} path @returns {{ events: any[], live: any[], notes: string|null }}
 */
export function readRecording(path) {
  if (!statSync(path).isDirectory()) return { events: linesIn(path), live: linesIn(join(path, '..', 'live.jsonl')), notes: null };
  if (existsSync(join(path, 'events.jsonl'))) return { events: linesIn(join(path, 'events.jsonl')), live: linesIn(join(path, 'live.jsonl')), notes: null };
  const data = existsSync(join(path, 'data')) ? join(path, 'data') : path;
  const segments = readdirSync(data)
    .filter((n) => /^events-\d+\.jsonl$/.test(n))
    .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
  if (!segments.length) throw new Error(`${path} has no events.jsonl and no Postbox log segments (events-<n>.jsonl), so there is nothing to export.`);
  const snap = existsSync(join(data, 'snapshot.json')) ? parseSnapshotText(readFileSync(join(data, 'snapshot.json'), 'utf8')) : null;
  // Only what a page may see, as the stream sends it.
  const logged = segments.flatMap((n) => linesIn(join(data, n))).filter((e) => Object.hasOwn(EVENTS, e.type) && EVENTS[e.type].public);
  const notes = snap ? `Steps before event ${snap.seq + 1} come from the store’s snapshot, which keeps each item as it ended, not each event.` : null;
  return { events: [...(snap ? snapshotEvents(snap) : []), ...logged], live: [], notes };
}

/**
 * The run’s trajectories, written to a folder: one file per agent session.
 * @param {string} out @param {{ events: any[], live?: any[], notes?: string|null }} rec @param {{ sessionId?: string, handle?: string }} [only]
 * @returns {string[]} the files written
 */
export function writeTrajectories(out, rec, only = {}) {
  const found = pick(rec, only);
  if (!found.length) return [];
  mkdirSync(out, { recursive: true });
  return found.map(({ sessionId, handle, trajectory }) => {
    const file = join(out, `${handle ?? 'agent'}-${sessionId}.atif.json`);
    writeFileSync(file, `${JSON.stringify(trajectory, null, 2)}\n`);
    return file;
  });
}

/** The recording’s trajectories, for one session or one handle if asked. @param {any} rec @param {{ sessionId?: string, handle?: string }} only */
function pick(rec, { sessionId, handle }) {
  return trajectories(rec.events, { version: POSTBOX_VERSION, live: rec.live ?? [], sessionId })
    .filter((t) => !handle || t.handle === handle)
    .map((t) => (rec.notes ? { ...t, trajectory: { ...t.trajectory, notes: rec.notes } } : t));
}

/** @param {string[]} argv */
function main(argv) {
  const [path, ...rest] = argv;
  const flag = (/** @type {string} */ name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!path || path.startsWith('--')) {
    console.error('Usage: node tools/atif-export.mjs <events.jsonl | UAT run folder | data folder> [--session <id> | --agent <handle>] [--out <folder>]');
    return 2;
  }
  const rec = readRecording(path);
  const only = { sessionId: flag('--session'), handle: flag('--agent')?.replace(/^@/, '') };
  const out = flag('--out');
  if (out) {
    const files = writeTrajectories(out, rec, only);
    for (const f of files) console.log(f);
    if (!files.length) console.error('No agent in that recording has a step to export.');
    return files.length ? 0 : 1;
  }
  const found = pick(rec, only);
  if (found.length !== 1) {
    console.error(`${found.length} trajectories match. Name one with --session or --agent, or write them all with --out <folder>.`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(found[0].trajectory, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
