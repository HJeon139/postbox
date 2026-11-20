// Writes ATIF v1.8 trajectories (tools/atif.mjs) from a recorded Postbox event stream, outside a UAT run too, so a
// harness that records /api/stream (Track A’s recorder) can reuse it:
//
//   node tools/atif-export.mjs <recording> [--session <id> | --agent <handle>] [--out <folder>] [--partial]
//
// <recording> is one of:
// - a JSON Lines file of events as /api/stream sends them ({ seq, type, data }, one per line, or a commit’s array),
//   with a live.jsonl beside it read for the steps’ input and output, if there is one;
// - a UAT run’s folder, which holds events.jsonl and live.jsonl (tools/uat/history.mjs, writeHistory);
// - a Postbox data folder, or a folder with one in `data/`: its snapshot.json, then its log segments in order. The
//   store deletes a segment once a snapshot covers it, so what came before the snapshot is rebuilt from the state
//   there, which has lost much (SNAPSHOT_LOSES): such an export needs --partial, and its notes and extra.partial
//   say what it lost.
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
 * What a data folder’s snapshot no longer has of what came before it, so an export rebuilt from one says so: the store
 * keeps state there, not the events that made it (designs/architecture/store.md).
 */
export const SNAPSHOT_LOSES = Object.freeze([
  'each run clock’s pauses, resumes, turns and restarts (only its start, and its expiry if it expired, are rebuilt)',
  'where each block’s answer came among the other events (it is placed beside its block)',
  'each item’s earlier revisions and the words of a reply as they streamed',
  'which inbox entries a turn took and then gave back (only each entry’s last state is kept)',
  'live frames, so no tool call’s input or output',
  'the work ledger’s entries other than turns, commands, outside calls and reads',
]);

/**
 * The events and live frames of a recording, and a note on what they leave out.
 * @param {string} path @returns {{ events: any[], live: any[], notes: string|null, partial?: { reconstructed_before_event: number, lost: readonly string[] } }}
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
  if (!snap) return { events: logged, live: [], notes: null };
  const partial = { reconstructed_before_event: snap.seq + 1, lost: SNAPSHOT_LOSES };
  const notes = `Partial: steps before event ${snap.seq + 1} are rebuilt from the store’s snapshot, which has lost ${SNAPSHOT_LOSES.join('; ')}.`;
  return { events: [...snapshotEvents(snap), ...logged], live: [], notes, partial };
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
    .map((t) =>
      rec.notes
        ? {
            ...t,
            trajectory: {
              ...t.trajectory,
              notes: `${rec.notes} ${t.trajectory.notes}`,
              extra: { ...t.trajectory.extra, ...(rec.partial ? { partial: rec.partial } : {}) },
            },
          }
        : t,
    );
}

/**
 * The command line: writes the trajectories, or says why it didn’t. A recording rebuilt from a snapshot is exported
 * only with --partial, so a partial record isn’t taken for a whole one. @param {string[]} argv @returns {number} the exit code
 */
export function main(argv) {
  const [path, ...rest] = argv;
  const flag = (/** @type {string} */ name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!path || path.startsWith('--')) {
    console.error(
      'Usage: node tools/atif-export.mjs <events.jsonl | UAT run folder | data folder> [--session <id> | --agent <handle>] [--out <folder>] [--partial]',
    );
    return 2;
  }
  const rec = readRecording(path);
  if (rec.partial && !rest.includes('--partial')) {
    console.error(
      `${path} keeps only a snapshot of what came before event ${rec.partial.reconstructed_before_event}, so its trajectories would be partial: they would have lost ${SNAPSHOT_LOSES.join('; ')}. Export from a recording of /api/stream instead, or pass --partial to write them marked partial.`,
    );
    return 1;
  }
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
