// Writes ATIF v1.8 trajectories (tools/atif.mjs) from a recorded Postbox event stream, outside a UAT run too, so a
// harness that records /api/stream (Track A’s recorder) can reuse it:
//
//   node tools/atif-export.mjs <recording> [--session <id> | --agent <handle>] [--out <folder>] [--partial]
//
// <recording> is one of:
// - a JSON Lines file of events as /api/stream sends them ({ seq, type, data }, one per line, or a commit’s array),
//   with a live.jsonl beside it read for the steps’ input and output, if there is one;
// - a UAT run’s folder, which holds events.jsonl and live.jsonl (tools/uat/history.mjs, writeHistory);
// - a Postbox data folder, or a folder with one in `data/`: its snapshot.json, then its log’s events after it, in
//   order. The store deletes a segment once a snapshot covers it, so what came before the snapshot is rebuilt from the
//   state there, which has lost much (SNAPSHOT_LOSES): such an export needs --partial, and its notes and extra.partial
//   say what it lost.
// Each turn’s prompt comes from prompts.jsonl, which a UAT run records in its data folder (#1528): beside the events
// file, or in the run’s or the data folder. Without it, a trajectory says what it leaves out (tools/atif-prompts.mjs).
// Each call’s output comes from the data folder’s blobs, which the work ledger names by hash; from what a live frame
// carried only where no blob reads back; and for a background command with neither, from the last output the ledger
// kept, said to be possibly its job’s (tools/atif-calls.mjs, #1757).
// Each trajectory goes to <out>/<handle>-<session>.atif.json; with no --out and one trajectory, to standard output.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshotText } from '../server/store-snapshot-lines.mjs';
import { PROMPTS_FILE } from '../server/turn-prompt.mjs';
import { EVENTS } from '../shared/state.mjs';
import { trajectories } from './atif.mjs';
import { WORK_KINDS } from './atif-calls.mjs';
import { lines } from './uat/history.mjs';
import { readStreams } from './uat/run-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Postbox’s version, as each trajectory’s agent.version. */
export const POSTBOX_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** The JSON Lines in a file, or none when it isn’t there. @param {string} file */
const linesIn = (file) => (existsSync(file) ? lines(readFileSync(file, 'utf8')) : []);

/**
 * A reader of the store's blobs in the first of these data folders that has a blobs folder (server/blobs.mjs), for the
 * tool outputs the work ledger names by hash: a blob's text, or null when it's missing or no longer matches its hash.
 * With no blobs folder, none. @param {string[]} dirs @returns {((sha256: string) => string | null) | undefined}
 */
const blobsIn = (dirs) => {
  const root = dirs.map((d) => join(d, 'blobs')).find((b) => existsSync(b));
  if (!root) return undefined;
  return (sha256) => {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
    const file = join(root, sha256.slice(0, 2), sha256.slice(2));
    // A blob that can’t be read (missing, a folder, not the owner’s) is no output, never a failed export.
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return null;
    }
    return createHash('sha256').update(buf).digest('hex') === sha256 ? buf.toString('utf8') : null;
  };
};

/** prompts.jsonl’s rows from the first of these folders that has one (server/turn-prompt.mjs), or none. @param {string[]} dirs */
const promptsIn = (dirs) => {
  const file = dirs.map((d) => join(d, PROMPTS_FILE)).find((f) => existsSync(f));
  return file ? linesIn(file) : [];
};

/**
 * A data folder’s snapshot as events placed before the log’s: each session, each item as it ended, the work ledger’s
 * turns and calls, each inbox’s entries, and each clock as it stood: its start, its expiry if it expired or its end if the
 * person ended it (#1749), with `voided` if its run was void (tools/atif-clock.mjs, clockVoid). @param {Record<string, any>} snap
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
      out.push({
        type: 'clock.expired',
        data: { sessionId: c.sessionId, elapsedMs: c.budgetMs, budgetMs: c.budgetMs, at: c.expiredAt, ...(c.voided ? { voided: c.voided } : {}) },
      });
    // The person ended it before its budget (#1749), at the time it had used.
    if (c.state === 'ended')
      out.push({
        type: 'clock.ended',
        data: { sessionId: c.sessionId, elapsedMs: c.usedMs, budgetMs: c.budgetMs, at: c.endedAt, ...(c.voided ? { voided: c.voided } : {}) },
      });
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
  'each run clock’s pauses, resumes, turns, stops and restarts (only its start, and its expiry or end if it had one, with whether its run was void, are rebuilt)',
  'where each block’s answer came among the other events (it is placed beside its block)',
  'each item’s earlier revisions and the words of a reply as they streamed',
  'which inbox entries a turn took and then gave back (only each entry’s last state is kept)',
  'live frames, so no tool call’s input, and no output but what the store’s blobs keep',
  'the work ledger’s entries other than turns, commands, outside calls and reads',
]);

/**
 * The events and live frames of a recording, and a note on what they leave out.
 * @param {string} path @returns {{ events: any[], live: any[], prompts: any[], notes: string|null, gaps?: { after: number, at: number }[], streams?: { handle: string, started?: number, events: any[] }[], partial?: { reconstructed_before_event: number, lost: readonly string[] } }}
 */
export function readRecording(path) {
  if (!statSync(path).isDirectory()) {
    const beside = join(path, '..');
    return {
      events: linesIn(path),
      live: linesIn(join(beside, 'live.jsonl')),
      prompts: promptsIn([beside, join(beside, 'data')]),
      blob: blobsIn([beside, join(beside, 'data')]),
      // A run’s events file has its streams beside it, as its folder does (#1758).
      streams: readStreams(join(beside, 'streams')),
      notes: null,
    };
  }
  if (existsSync(join(path, 'events.jsonl'))) return { ...runRecording(path), notes: null };
  const data = existsSync(join(path, 'data')) ? join(path, 'data') : path;
  const segments = readdirSync(data)
    .filter((n) => /^events-\d+\.jsonl$/.test(n))
    .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
  if (!segments.length) throw new Error(`${path} has no events.jsonl and no Postbox log segments (events-<n>.jsonl), so there is nothing to export.`);
  const snap = existsSync(join(data, 'snapshot.json')) ? parseSnapshotText(readFileSync(join(data, 'snapshot.json'), 'utf8')) : null;
  // Only what a page may see, as the stream sends it.
  const logged = segments.flatMap((n) => linesIn(join(data, n))).filter((e) => Object.hasOwn(EVENTS, e.type) && EVENTS[e.type].public);
  const prompts = promptsIn([data]);
  const blob = blobsIn([data]);
  if (!snap) return { events: logged, live: [], prompts, blob, notes: null };
  const partial = { reconstructed_before_event: snap.seq + 1, lost: SNAPSHOT_LOSES };
  const notes = `Partial: steps before event ${snap.seq + 1} are rebuilt from the store’s snapshot, which has lost ${SNAPSHOT_LOSES.join('; ')}.`;
  // A segment’s first events are often in the snapshot already (server/store-replay.mjs): only those after it count.
  return { events: [...snapshotEvents(snap), ...logged.filter((e) => e.seq > snap.seq)], live: [], prompts, blob, notes, partial };
}

/**
 * The run’s trajectories, written to a folder: one file per agent session.
 * @param {string} out @param {{ events: any[], live?: any[], prompts?: any[], notes?: string|null, gaps?: { after: number, at: number }[], streams?: { handle: string, started?: number, events: any[] }[] }} rec @param {{ sessionId?: string, handle?: string }} [only]
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
  const lost = gapNote(rec.gaps);
  const notes = [rec.notes, lost].filter(Boolean).join(' ');
  const partial = { ...rec.partial, ...(rec.gaps?.length ? { stream_gaps: rec.gaps } : {}) };
  return trajectories(rec.events, {
    version: POSTBOX_VERSION,
    live: rec.live ?? [],
    prompts: rec.prompts ?? [],
    blob: rec.blob,
    streams: rec.streams ?? [],
    sessionId,
  })
    .filter((t) => !handle || t.handle === handle)
    .map((t) =>
      notes
        ? {
            ...t,
            trajectory: {
              ...t.trajectory,
              notes: `${notes} ${t.trajectory.notes}`,
              extra: { ...t.trajectory.extra, ...(Object.keys(partial).length ? { partial } : {}) },
            },
          }
        : t,
    );
}

/**
 * What a recording says of the events it lost where its stream had to resync (tools/uat/history.mjs, gaps), or null
 * when it lost none. @param {{ after: number, at: number }[] | undefined} gaps
 */
function gapNote(gaps) {
  if (!gaps?.length) return null;
  const events = gaps.filter((g) => g.lost !== 'live');
  const live = gaps.filter((g) => g.lost === 'live');
  // A restart numbers events from lower again (tools/uat/history.mjs, streamRecorder), so a gap after one names its epoch.
  const at = (/** @type {any} */ g) => (g.epoch ? `${g.after} of epoch ${g.epoch}` : String(g.after));
  const where = (/** @type {any[]} */ list) => `after event ${list.map(at).join(', ')}`;
  const said = [
    events.length
      ? `lost events ${events.length === 1 ? 'once' : `${events.length} times`}, ${where(events)}, where the server could no longer replay them, so steps that came between are missing`
      : '',
    live.length
      ? `was cut off ${live.length === 1 ? 'once' : `${live.length} times`}, ${where(live)}, so tool inputs and outputs sent while it was away (live frames, which aren’t replayed) are missing`
      : '',
  ].filter(Boolean);
  return `Partial: the recording of /api/stream ${said.join('; and it ')}.`;
}

/**
 * A UAT run’s folder (tools/uat/history.mjs, writeHistory): its events, its live frames, where its stream lost events,
 * and its Claude Code turns’ recorded streams (streams/, tools/atif-streams.mjs). @param {string} dir
 */
function runRecording(dir) {
  const gaps = existsSync(join(dir, 'stream-gaps.json')) ? JSON.parse(readFileSync(join(dir, 'stream-gaps.json'), 'utf8')) : [];
  return {
    events: linesIn(join(dir, 'events.jsonl')),
    live: linesIn(join(dir, 'live.jsonl')),
    prompts: promptsIn([dir, join(dir, 'data')]),
    blob: blobsIn([dir, join(dir, 'data')]),
    gaps,
    streams: readStreams(join(dir, 'streams')),
  };
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
