// Recording a room for telemetry (designs/telemetry-persona.md, R1, R5, R7, R10, R11). Unlisted: no agent, session or
// line in the room. While a conversation records, Postbox keeps each turn’s raw stream for it and its side and topic
// threads, the turns, and its events, in <Postbox folder>/telemetry/<conversation id>/recording/, and the reports you
// save beside it in reports/, folders 0700 and files 0600, never in the project. Its state is on the conversation
// (thread.recording), which only the header shows; no agent reads it. The whole folder goes with the conversation (after
// Undo’s window); recording/ goes at once with Delete recordings, and each stream 30 days after it was last written.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStreamTap } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';
import { postboxHome } from './home.mjs';
import { keepEvent } from './room-events.mjs';

/** How long a recording is kept, at most (R11). */
export const KEEP_MS = 30 * 864e5;
const SWEEP_MS = 864e5;

/** A clone’s implicit data/ folder, which is often inside the folder its agents work in (R11). */
const CLONE_DATA = fileURLToPath(new URL('../data', import.meta.url));

/** <data folder>/telemetry: --data’s or ~/.postbox’s, never a clone’s data/ (then ~/.postbox’s), or the tests’ own. */
export const telemetryRoot = (rt) =>
  rt.config.telemetryRoot ?? (rt.store.dir ? join(resolve(rt.store.dir) === CLONE_DATA ? postboxHome() : rt.store.dir, 'telemetry') : null);

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
/** A conversation’s recording/, and its reports/ (R11). */
export const recFolder = (rt, convId, ...parts) => folder(rt, convId, 'recording', ...parts);
export const reportFolder = (rt, convId, ...parts) => folder(rt, convId, 'reports', ...parts);
/** Writes or appends a file, owner-only (0600). */
export const write = (file, text) => writeFileSync(file, text, { mode: 0o600 });
export const append = (file, text) => appendFileSync(file, text, { mode: 0o600 });

/** The conversation a thread belongs to: itself, or the one its side or topic thread branched from. */
export const convOf = (rt, threadId) => rt.s.threads[rt.lineage(threadId).at(-1)] ?? null;

/** A path as the file system finds it: through links, from its nearest folder that exists, and case-folded where names are. */
function real(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  const out = join(realpathSync(head), ...tail);
  return ['darwin', 'win32'].includes(process.platform) ? out.toLowerCase() : out;
}
/** Whether a path is a folder or inside it, through links and case (R11). */
export function within(p, folder) {
  const rel = relative(real(folder), real(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Record this room: from now on, never before (R2). */
export function startRecording(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv || conv.kind === 'topic' || conv.kind === 'side') throw httpError(404, 'That conversation doesn’t exist.');
  if (conv.recording?.on) return { ok: true, recording: conv.recording };
  const project = rt.s.projects[conv.projectId]?.folder;
  const root = telemetryRoot(rt);
  if (project && root && within(root, project))
    throw httpError(
      409,
      'Postbox keeps recordings in its data folder, which is inside this project’s folder, where its agents could read them. Start Postbox with --data outside the project to record.',
    );
  recFolder(rt, conv.id, 'streams');
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

/** Delete recordings: recording/, at once (R11). Saved reports stay until you delete them; a room still recording starts afresh. */
export function deleteRecordings(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv) throw httpError(404, 'That conversation doesn’t exist.');
  const root = telemetryRoot(rt);
  if (root) rmSync(join(root, conv.id, 'recording'), { recursive: true, force: true });
  const now = Date.now();
  rt.putThread({ ...conv, recording: conv.recording?.on ? { on: true, since: now, startedAt: now, stoppedAt: null } : null });
  if (conv.recording?.on) recFolder(rt, conv.id, 'streams');
  return { ok: true };
}

/** The recording folder a turn in this thread writes to, or null when its conversation isn’t recording. */
export function recordingDir(rt, threadId) {
  const conv = convOf(rt, threadId);
  if (!conv?.recording?.on || conv.deleting) return null;
  try {
    return recFolder(rt, conv.id);
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
  const keep = recordLine(rt, begun);
  return (ctx, line, backend) => {
    // A failed write (a full disk, a folder made read-only) drops the line and marks the turn a gap: it never reaches
    // the adapter’s stream reader, which would end the turn, or Postbox (R10).
    try {
      keep(ctx, line, backend);
    } catch {
      const sid = /[?&]session=([^&]+)/.exec(String(ctx?.mcpUrl ?? ''))?.[1];
      const turn = sid ? rt.turns.get(decodeURIComponent(sid)) : null;
      if (turn) lostOf(rt).turns.add(turn.id);
    }
  };
}

/** What a failed write lost, per runtime: the turns, and the conversations whose events it couldn’t keep (R10). */
export const lostOf = (rt) => {
  rt.telemetryLost ??= { turns: new Set(), events: new Set() };
  return rt.telemetryLost;
};

function recordLine(rt, begun) {
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
      recFolder(rt, rt.lineage(turn.threadId).at(-1), 'streams', ...(sub ? [sub] : []));
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
    append(file, `${line}\n`);
  };
}

/**
 * Starts telemetry for a runtime (server/index.mjs calls it at start): the stream tap, the events of recorded rooms, the
 * deletion of a removed conversation’s recordings and reports, and the 30-day sweep, now and once a day.
 * @param {any} rt @returns {() => void} stops it
 */
export function watchTelemetry(rt) {
  const off = setStreamTap(rt, tapFor(rt));
  const unsubscribe = rt.store.subscribe((ev) => {
    // Whether or not it records now: a room that once did may have saved reports (R11).
    if (ev.type === 'remove' && ev.data?.kind === 'thread') purgeRoom(rt, ev.data.id);
    const threadId = ev.data?.threadId;
    if (!threadId || !rt.s.threads[threadId]) return;
    const kept = keepEvent(ev.seq, ev.type, ev.data);
    const dir = kept && recordingDir(rt, threadId);
    // A failed write here would throw into the store’s other listeners: it’s a gap instead.
    try {
      if (dir) append(join(dir, 'events.jsonl'), `${JSON.stringify({ ...kept, t: Date.now() })}\n`);
    } catch {
      lostOf(rt).events.add(rt.lineage(threadId).at(-1));
    }
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

/** A removed conversation’s telemetry folder: its recording and the reports saved from it (R11). */
function purgeRoom(rt, convId) {
  const root = telemetryRoot(rt);
  try {
    if (root && /^[\w-]+$/.test(convId)) rmSync(join(root, convId), { recursive: true, force: true });
  } catch {
    /* the next sweep tries again */
  }
}

/**
 * The 30-day rule (R11): each stream and draft last written more than 30 days ago is deleted, and each event recorded
 * that long ago; a recording with nothing newer goes with its ref map. A folder whose conversation is gone goes whole,
 * saved reports included, as when it was deleted while Postbox wasn’t running. Returns the paths it deleted.
 */
export function sweep(rt, now = Date.now()) {
  const root = telemetryRoot(rt);
  if (!root || !existsSync(root)) return [];
  const gone = [];
  for (const name of readdirSync(root)) {
    if (!rt.s.threads[name]) {
      rmSync(join(root, name), { recursive: true, force: true });
      gone.push(name);
      continue;
    }
    const rec = join(root, name, 'recording');
    if (!existsSync(rec)) continue;
    const old = [...filesIn(join(rec, 'streams')), ...filesIn(join(rec, 'drafts'))].filter((f) => now - statSync(f).mtimeMs > KEEP_MS);
    for (const f of old) {
      rmSync(f, { force: true });
      gone.push(relative(root, f));
    }
    ageEvents(join(rec, 'events.jsonl'), now);
    const rest = filesIn(rec);
    const fresh = rest.length ? rest.some((f) => now - statSync(f).mtimeMs <= KEEP_MS) : now - statSync(rec).mtimeMs <= KEEP_MS;
    if (filesIn(join(rec, 'streams')).length || fresh) continue;
    rmSync(rec, { recursive: true, force: true });
    gone.push(relative(root, rec));
  }
  return gone;
}

/** Keeps the events recorded in the last 30 days, by when each was recorded. */
function ageEvents(file, now) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => !(now - (Number(/"t":(\d+)/.exec(l)?.[1]) || now) > KEEP_MS));
  if (kept.length < lines.length) write(file, kept.length ? `${kept.join('\n')}\n` : '');
}

/** Every file under a folder; none if it’s missing. */
function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));
}

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
