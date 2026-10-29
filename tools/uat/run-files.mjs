// The run’s folders (runPaths), and what the UAT runner reads from files after each step: the person’s own Claude Code setup, to spot it leaking into
// agents (or missing from them), each agent turn’s recorded stream, and the agents’ own Claude Code transcripts.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
