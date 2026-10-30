// The run’s folders (runPaths), and what the UAT runner reads from files after each step: the person’s own Claude Code setup, to spot it leaking into
// agents (or missing from them), each agent turn’s recorded stream, and the agents’ own Claude Code transcripts.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { patchSession } from '../../shared/state.mjs';

/** The run’s folders, made: Postbox’s data, the workspace, each backend’s recorded streams, and screenshots. @param {string} dir */
export async function runPaths(dir) {
  const paths = {
    data: join(dir, 'data'),
    workspace: join(dir, 'workspace'),
    streams: join(dir, 'streams'),
    kiroStreams: join(dir, 'streams', 'kiro'),
    agyStreams: join(dir, 'streams', 'agy'),
    codexStreams: join(dir, 'streams', 'codex'),
    shots: join(dir, 'shots'),
  };
  for (const p of Object.values(paths)) await mkdir(p, { recursive: true });
  return paths;
}

export function userSetup(workspace) {
  const out = { userMcpServers: [], userRulesMarker: null };
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    out.userMcpServers = [...Object.keys(cfg.mcpServers ?? {}), ...Object.keys(cfg.projects?.[workspace]?.mcpServers ?? {})];
  } catch {}
  try {
    out.userRulesMarker =
      readFileSync(join(homedir(), '.claude', 'CLAUDE.md'), 'utf8')
        .split('\n')
        .map((l) => l.replace(/^[-#*\s]+/, '').trim())
        .find((l) => l.length >= 30) ?? null;
  } catch {}
  return out;
}

/** Each agent turn’s raw stream, as recorded by the Claude Code adapter (POSTBOX_CLAUDE_RECORD), by the Kiro CLI
 * adapter (POSTBOX_KIRO_RECORD) in streams/kiro/, or by the Antigravity CLI adapter (POSTBOX_AGY_RECORD) in streams/agy/.
 * A file is named for when its turn’s process started, and its last write is when that process last said anything (#126). */
export function readStreams(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      handle: f.replace(/^\d+-/, '').replace(/\.jsonl$/, ''),
      started: Number(/^(\d+)-/.exec(f)?.[1]) || undefined,
      ended: statSync(join(folder, f)).mtimeMs,
      events: readFileSync(join(folder, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
    }));
}

/** Where readReceived got to in each run’s old log: each segment’s bytes read, each session as the log left it, the snapshot read. */
const cursors = new Map();

/** A received message’s key, for merging reads. @param {{ handle: string, from: string, text: string, at: number }} r */
const keyOf = (r) => `${r.handle}|${r.from}|${r.at}|${r.text}`;

/**
 * The messages Postbox sent one agent from others, as its session holds them: recordAgentMessage
 * (server/side-threads.mjs) keeps an agent’s latest six on its session as agentMessages. A wake Postbox refuses has none.
 * @param {any} se  a whole session @param {string} [handle]  the session’s handle, when the session itself lacks it
 */
export function messagesOf(se, handle = se?.handle) {
  if (!handle || !Array.isArray(se?.agentMessages)) return [];
  return se.agentMessages.filter((m) => m?.dir === 'from' && Number.isFinite(m.at)).map((m) => ({ handle, from: m.other, text: m.text, at: m.at }));
}

/**
 * Every message Postbox sent one agent from another, read from what a run has (#553’s review, blocker 4). A run on the
 * Redis store has no log in its data folder: the messages are read from the sessions in its running Postbox’s state
 * (`state`, from /api/state, each session’s latest six) and from the stream the runner follows (`history`,
 * followEvents in tools/uat/history.mjs), which applies each session.patch with patchSession (shared/state.mjs, the
 * reducer’s own rule) and keeps every message it saw, so one the six-cap dropped between two reads isn’t lost. A run on
 * the old store, or a recheck of one, still reads the log in its data folder: snapshot.json, the state itself, seeds
 * each session, and the events-*.jsonl segments after it hold sessions and patches; a patch for a session neither held
 * is dropped, as the reducer drops it. Each read parses only what the log gained since the last one in this process.
 * Returned merged with `known`, what earlier reads found, which the caller keeps.
 * @param {string} data  the run’s Postbox data folder
 * @param {{ handle: string, from: string, text: string, at: number }[]} [known]
 * @param {{ state?: any, history?: { received: () => { handle: string, from: string, text: string, at: number }[] } }} [live]
 */
export function readReceived(data, known = [], { state = null, history = null } = {}) {
  const out = new Map(known.map((r) => [keyOf(r), r]));
  for (const se of Object.values(state?.sessions ?? {})) for (const r of messagesOf(se)) out.set(keyOf(r), r);
  for (const r of history?.received() ?? []) out.set(keyOf(r), r);
  if (existsSync(data)) readLogged(data, out);
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/** The old store’s log in a data folder, read on from where this process got to. @param {string} data @param {Map<string, any>} out */
function readLogged(data, out) {
  const c = cursors.get(data) ?? { offsets: new Map(), sessions: new Map(), snapshot: null };
  cursors.set(data, c);
  /** Keeps a session as an event left it, and takes the messages it holds. */
  const take = (/** @type {any} */ se) => {
    if (!se?.id) return;
    // A whole session without a handle (a trimmed fixture) keeps the handle the log gave it before.
    const handle = se.handle ?? c.sessions.get(se.id)?.handle;
    c.sessions.set(se.id, handle === undefined ? se : { ...se, handle });
    for (const r of messagesOf(se, handle)) out.set(keyOf(r), r);
  };
  try {
    const snap = join(data, 'snapshot.json');
    const changed = statSync(snap).mtimeMs;
    // snapshot.json is the state as of some sequence number, with its sessions at the top level.
    if (changed !== c.snapshot) for (const se of Object.values(JSON.parse(readFileSync(snap, 'utf8')).sessions ?? {})) take(se);
    c.snapshot = changed;
  } catch {}
  const segments = readdirSync(data).filter((n) => /^events-\d+\.jsonl$/.test(n));
  for (const n of segments.sort((a, b) => Number(/\d+/.exec(a)) - Number(/\d+/.exec(b)))) {
    const { text, next } = gained(join(data, n), c.offsets.get(n) ?? 0);
    c.offsets.set(n, next);
    for (const l of text.split('\n')) {
      try {
        const e = JSON.parse(l);
        if (e?.type === 'session') take(e.data);
        else if (e?.type === 'session.patch' && c.sessions.has(e.data?.id)) take(patchSession(c.sessions.get(e.data.id), e.data));
      } catch {}
    }
  }
}

/** A log file’s whole lines after this byte, and where the next read starts; a file shorter than that was rewritten. */
function gained(file, from) {
  const size = statSync(file).size;
  const at = size < from ? 0 : from;
  if (size === at) return { text: '', next: at };
  const buf = Buffer.alloc(size - at);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, at);
  } finally {
    closeSync(fd);
  }
  // A line still being written waits for the next read.
  const end = buf.lastIndexOf(10) + 1;
  return { text: buf.subarray(0, end).toString('utf8'), next: at + end };
}

/** The agents’ own Claude Code transcripts, where injected reminders and settings show up. */
export function readTranscripts(facts, workspace) {
  return facts.threads
    .flatMap((t) => facts.state.threads[t]?.members ?? [])
    .map((id) => facts.state.sessions[id])
    .filter((se) => se?.backendState?.claudeSessionId)
    .map((se) => ({ handle: se.handle, file: transcriptOf(workspace, se.backendState.claudeSessionId) }))
    .filter((t) => existsSync(t.file))
    .map((t) => ({ handle: t.handle, lines: readFileSync(t.file, 'utf8').split('\n') }));
}

/** Where a run folder keeps its agents’ transcript lines (keepTranscripts). @param {string} dir */
const keptIn = (dir) => join(dir, 'transcripts');

/**
 * Keeps the transcript lines the checks read in the run folder, for --recheck once the agents’ own transcripts have
 * gone: each agent’s user lines (its prompts, tool results and the lines Claude Code writes itself, as
 * server/room-delivery.mjs’s inputsOf and the telemetry triggers read them), in <dir>/transcripts/<handle>.jsonl.
 * Not its replies, which no check reads, nor a line cut short.
 * @param {string} dir  @param {{ handle: string, lines: (string|object)[] }[]} transcripts
 */
export function keepTranscripts(dir, transcripts) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const t of transcripts ?? [])
    for (const l of t.lines ?? []) {
      let e;
      try {
        e = typeof l === 'string' ? JSON.parse(l) : l;
      } catch {
        continue;
      }
      if (e?.type !== 'user') continue;
      by.set(t.handle, [...(by.get(t.handle) ?? []), typeof l === 'string' ? l : JSON.stringify(l)]);
    }
  mkdirSync(keptIn(dir), { recursive: true });
  for (const [handle, lines] of by) writeFileSync(join(keptIn(dir), `${handle.replace(/[^\w-]/g, '_')}.jsonl`), `${lines.join('\n')}\n`);
}

/** The transcript lines a run folder kept (keepTranscripts), as readTranscripts gives them; null when it kept none. @param {string} dir */
export function savedTranscripts(dir) {
  if (!existsSync(keptIn(dir))) return null;
  return readdirSync(keptIn(dir))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ handle: f.replace(/\.jsonl$/, ''), lines: readFileSync(join(keptIn(dir), f), 'utf8').split('\n') }));
}

/**
 * The run’s keep (tools/uat/stop.mjs’s runStop calls it at the end, early stop or not): the transcript lines the
 * checks read, kept in the run folder for --recheck, once the run has a state to name its agents.
 * @param {string} dir  @param {any} facts  @param {string} workspace
 */
export const keeper = (dir, facts, workspace) => () => {
  if (facts.state) keepTranscripts(dir, readTranscripts(facts, workspace));
};

/** What --recheck reads: the transcripts the run folder kept, or, from a run before it kept them, the agents’ own. */
export const transcriptsFor = (dir, facts) => savedTranscripts(dir) ?? readTranscripts(facts, join(dir, 'workspace'));

const transcriptOf = (cwd, id) => join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);

/**
 * What the page shows that the checks read (#105, #146): the Agents section’s text and rows, whether the top bar cuts
 * its title or project, and the raw table rows each review block shows.
 * @param {any} page  from tools/browser.mjs launch()
 */
export async function readUi(page) {
  return {
    // The conversation’s header, where recording shows (designs/telemetry-persona.md, R5).
    recordingBadge: await page.evaluate(`document.querySelector('#recording-badge')?.textContent ?? ''`),
    headerText: await page.evaluate(`document.querySelector('.rail .agents-sec')?.innerText ?? ''`),
    agentRows: await page.evaluate(
      `[...document.querySelectorAll('.agent-rows .agent-btn')].map((b) => (/@([\\w-]+)/.exec(b.textContent) ?? [])[1]).filter(Boolean)`,
    ),
    topbarCut: await page.evaluate(
      `innerWidth >= 1200 && [...document.querySelectorAll('header.topbar .title, header.topbar .crumb')].some((n) => n.scrollWidth > n.clientWidth + 1)`,
    ),
    // Each refusal card’s buttons and text (#238): what the allow-once scenario’s chained-command trigger reads.
    denialCards: await page.evaluate(
      `Object.fromEntries([...document.querySelectorAll('[data-key]')].filter((n) => /^Refused/.test(n.querySelector('.block-head .kind')?.textContent ?? '')).map((n) => [n.dataset.key, { buttons: [...n.querySelectorAll('.block-foot button')].map((b) => b.textContent.trim()), text: n.querySelector('.block-body')?.innerText ?? '' }]))`,
    ),
    reviewRawRows: await page.evaluate(
      `Object.fromEntries([...document.querySelectorAll('[data-key]')].filter((n) => n.querySelector(':scope .rv-doc')).map((n) => [n.dataset.key, n.querySelector('.rv-doc').innerText.split('\\n').filter((l) => /^\\s*\\|.*\\|\\s*$/.test(l)).length]))`,
    ),
  };
}
