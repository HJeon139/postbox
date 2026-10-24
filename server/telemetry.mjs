// Recording a room for telemetry (designs/telemetry-persona.md, R1, R5, R7, R10, R11). Unlisted: no agent, session or
// line in the room. While a conversation records, Postbox keeps each turn’s raw stream for it and its side and topic
// threads, the turns, and its events, in <data folder>/telemetry/<conversation id>/, folders 0700 and files 0600, never
// in the project. Its state is on the conversation (thread.recording), which only the header shows; no agent reads it.
// Recordings go with the conversation (after Undo’s window), at once with Delete recordings, and after 30 days.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStreamTap } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';
import { keepEvent } from './room-events.mjs';

/** How long a recording is kept, at most (R11). */
export const KEEP_MS = 30 * 864e5;
const SWEEP_MS = 864e5;

/** <data folder>/telemetry, or the folder the tests give. */
export const telemetryRoot = (rt) => rt.config.telemetryRoot ?? (rt.store.dir ? join(rt.store.dir, 'telemetry') : null);

/** A folder under telemetry/, made owner-only (0700) along the way. */
export function folder(rt, ...parts) {
  const root = telemetryRoot(rt);
  if (!root) throw httpError(409, 'Postbox has no data folder to keep recordings in.');
  let p = root;
  for (const part of ['', ...parts]) {
    p = part ? join(p, part) : p;
    if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
  }
  return p;
}
/** Writes or appends a file, owner-only (0600). */
export const write = (file, text) => writeFileSync(file, text, { mode: 0o600 });
export const append = (file, text) => appendFileSync(file, text, { mode: 0o600 });

/** The conversation a thread belongs to: itself, or the one its side or topic thread branched from. */
export const convOf = (rt, threadId) => rt.s.threads[rt.lineage(threadId).at(-1)] ?? null;

/** Record this room: from now on, never before (R2). */
export function startRecording(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv || conv.kind === 'topic' || conv.kind === 'side') throw httpError(404, 'That conversation doesn’t exist.');
  if (conv.recording?.on) return { ok: true, recording: conv.recording };
  folder(rt, conv.id, 'streams');
  const recording = { on: true, since: conv.recording?.since ?? Date.now(), startedAt: Date.now(), stoppedAt: null };
  rt.putThread({ ...conv, recording });
  return { ok: true, recording };
}

/** Stop recording: from the next turn; what was recorded stays (R11). */
export function stopRecording(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv?.recording?.on) return { ok: true };
  rt.putThread({ ...conv, recording: { ...conv.recording, on: false, stoppedAt: Date.now() } });
  return { ok: true };
}

/** Delete recordings, at once (R11). Saved reports stay until you delete them; a room still recording starts afresh. */
export function deleteRecordings(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv) throw httpError(404, 'That conversation doesn’t exist.');
  const root = telemetryRoot(rt);
  if (root) rmSync(join(root, conv.id), { recursive: true, force: true });
  const now = Date.now();
  rt.putThread({ ...conv, recording: conv.recording?.on ? { on: true, since: now, startedAt: now, stoppedAt: null } : null });
  if (conv.recording?.on) folder(rt, conv.id, 'streams');
  return { ok: true };
}

/** The recording folder a turn in this thread writes to, or null when its conversation isn’t recording. */
export function recordingDir(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv?.recording?.on || conv.deleting) return null;
  try {
    return folder(rt, conv.id);
  } catch {
    return null;
  }
}

/**
 * Takes each line an agent turn’s backend streams, for a recorded room (R7): the stream goes to streams/, as the
 * POSTBOX_*_RECORD formats write it, and the turn to turns.jsonl the first time. Which turn it is comes from the
 * turn’s own MCP address, which names its session.
 * @param {any} rt
 * @returns {(ctx: any, line: string, backend: string) => void}
 */
function tapFor(rt) {
  const begun = new Map(); // turn id → stream file
  return (ctx, line, backend) => {
    const sid = /[?&]session=([^&]+)/.exec(String(ctx?.mcpUrl ?? ''))?.[1];
    const turn = sid ? rt.turns.get(decodeURIComponent(sid)) : null;
    const se = turn && rt.s.sessions[turn.sessionId];
    if (!se) return;
    const dir = recordingDir(rt, turn.threadId);
    if (!dir) return;
    let file = begun.get(turn.id);
    if (!file) {
      const sub = { 'kiro-cli': 'kiro', 'antigravity-cli': 'agy', codex: 'codex' }[backend];
      const rel = join('streams', ...(sub ? [sub] : []), `${turn.startedAt}-${turn.id}.jsonl`);
      folder(rt, rt.lineage(turn.threadId).at(-1), 'streams', ...(sub ? [sub] : []));
      file = join(dir, rel);
      begun.set(turn.id, file);
      const t = {
        turnId: turn.id,
        sessionId: se.id,
        personaId: se.personaId,
        threadId: turn.threadId,
        kind: turn.kind,
        backend,
        startedAt: turn.startedAt,
        stream: rel,
      };
      append(join(dir, 'turns.jsonl'), `${JSON.stringify(t)}\n`);
    }
    try {
      append(file, `${line}\n`);
    } catch {
      /* the recording was deleted meanwhile */
    }
  };
}

/** The recorded rooms, by id: a removed conversation’s recordings go with it. */
const recorded = (rt) =>
  new Set(
    Object.values(rt.s.threads)
      .filter((t) => t.recording)
      .map((t) => t.id),
  );

/**
 * Starts telemetry for a runtime (server/index.mjs calls it at start): the stream tap, the events of recorded rooms, the
 * deletion of a removed conversation’s recordings and reports, and the 30-day sweep, now and once a day.
 * @param {any} rt @returns {() => void} stops it
 */
export function watchTelemetry(rt) {
  const known = recorded(rt);
  const off = setStreamTap(rt, tapFor(rt));
  const unsubscribe = rt.store.subscribe((ev) => {
    if (ev.type === 'thread' && ev.data?.recording) known.add(ev.data.id);
    if (ev.type === 'remove' && ev.data?.kind === 'thread' && known.has(ev.data.id)) {
      known.delete(ev.data.id);
      purgeRoom(rt, ev.data.id);
    }
    const threadId = ev.data?.threadId;
    if (!threadId || !rt.s.threads[threadId]) return;
    const kept = keepEvent(ev.seq, ev.type, ev.data);
    const dir = kept && recordingDir(rt, threadId);
    if (dir) append(join(dir, 'events.jsonl'), `${JSON.stringify(kept)}\n`);
  });
  sweep(rt);
  const timer = setInterval(() => sweep(rt), SWEEP_MS);
  timer.unref?.();
  return () => {
    off();
    unsubscribe();
    clearInterval(timer);
  };
}

/** A removed conversation’s recordings, and the reports saved from it (R11). */
function purgeRoom(rt, convId) {
  const root = telemetryRoot(rt);
  if (!root) return;
  rmSync(join(root, convId), { recursive: true, force: true });
  const index = reportIndex(rt);
  for (const [id, room] of Object.entries(index)) if (room === convId) rmSync(join(root, 'reports', id), { recursive: true, force: true });
  writeIndex(rt, Object.fromEntries(Object.entries(index).filter(([, room]) => room !== convId)));
}

/** Recordings last written more than 30 days ago are deleted (R11). Saved reports stay until you delete them. */
export function sweep(rt, now = Date.now()) {
  const root = telemetryRoot(rt);
  if (!root || !existsSync(root)) return [];
  const gone = [];
  for (const name of readdirSync(root)) {
    if (name === 'reports') continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory() || now - newest(dir) <= KEEP_MS) continue;
    rmSync(dir, { recursive: true, force: true });
    gone.push(name);
  }
  return gone;
}

/** The newest modification time under a folder. */
function newest(dir) {
  let t = statSync(dir).mtimeMs;
  for (const e of readdirSync(dir, { withFileTypes: true })) t = Math.max(t, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs);
  return t;
}

/** Which conversation each saved report came from: reports/index.json, local only (R15). */
export function reportIndex(rt) {
  try {
    return JSON.parse(readFileSync(join(folder(rt, 'reports'), 'index.json'), 'utf8'));
  } catch {
    return {};
  }
}
export const writeIndex = (rt, index) => write(join(folder(rt, 'reports'), 'index.json'), JSON.stringify(index));

/** Whether a session’s turn is still running, so its stream isn’t whole yet (R10). */
export const running = (rt, t) => rt.turns.get(t.sessionId)?.id === t.turnId;

/** A JSON Lines file’s values, skipping lines that don’t parse; empty if it’s missing. */
export function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}
