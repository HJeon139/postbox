// What the UAT runner reads from files after each step: the person’s own Claude Code setup, to spot it leaking into
// agents (or missing from them), each agent turn’s recorded stream, and the agents’ own Claude Code transcripts.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Where readReceived got to in each run’s store: each segment’s bytes read, the handles seen, the snapshot read. */
const cursors = new Map();

/**
 * Every message Postbox sent one agent from another, read from the run’s store: recordAgentMessage
 * (server/side-threads.mjs) keeps an agent’s latest six on its session, and each change is a session event in the log.
 * A wake Postbox refuses has none. Each read parses only what the log gained since the last one in this process, and
 * returns it merged with known, what earlier reads found, which the caller keeps; that also covers a snapshot deleting
 * the segments it covers. If one does between two reads, and more than six messages reached one agent meanwhile (the
 * session keeps its latest six, `.slice(0, 6)` in recordAgentMessage), the oldest are lost, and a delivered call reads
 * as refused.
 * @param {string} data  the run’s Postbox data folder
 * @param {{ handle: string, from: string, text: string, at: number }[]} [known]
 */
export function readReceived(data, known = []) {
  if (!existsSync(data)) return known;
  const c = cursors.get(data) ?? { offsets: new Map(), handles: new Map(), snapshot: null };
  cursors.set(data, c);
  const key = (/** @type {any} */ r) => `${r.handle}|${r.from}|${r.at}|${r.text}`;
  const out = new Map(known.map((r) => [key(r), r]));
  const take = (/** @type {any} */ se) => {
    if (se?.handle) c.handles.set(se.id, se.handle);
    const handle = c.handles.get(se?.id);
    for (const m of Array.isArray(se?.agentMessages) ? se.agentMessages : [])
      if (handle && m?.dir === 'from' && Number.isFinite(m.at))
        out.set(key({ handle, from: m.other, text: m.text, at: m.at }), { handle, from: m.other, text: m.text, at: m.at });
  };
  try {
    const snap = join(data, 'snapshot.json');
    const changed = statSync(snap).mtimeMs;
    if (changed !== c.snapshot) for (const se of Object.values(JSON.parse(readFileSync(snap, 'utf8')).state?.sessions ?? {})) take(se);
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
      } catch {}
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
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
