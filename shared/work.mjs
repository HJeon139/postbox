// The work ledger (#132): what a conversation’s agents changed, ran and published, and what it took. These are
// the pure parts the server (server/ledger.mjs) and the Work view (app/js/work.mjs) share: line counts from a
// diff, what a command line did to version control and to services outside Postbox, and the totals.

import { formatDuration } from './text.mjs';
import { ledgerIndex } from './work-index.mjs';

/** Files larger than this are listed with their sizes, but not copied, diffed or restored. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** A command’s output is kept up to this, its end when longer. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Lines a diff shows before it stops; the counts are still exact past it. */
export const MAX_DIFF_ROWS = 4000;

/** The tools that change a file, and the input field that names it (recorded: tests/fixtures/claude-code/ledger-*.jsonl). */
export const EDIT_TOOLS = /** @type {Record<string, string>} */ ({
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
});
/** The tools that run a command line. */
export const COMMAND_TOOLS = new Set(['Bash']);
/** The tools that read a file or the web (#195), and the input field that says what. */
export const READ_TOOLS = /** @type {Record<string, string>} */ ({
  Read: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
});

export { diffCount, diffRows, hunks, isBinary, splitLines } from './diff.mjs';

// ── Commands ────────────────────────────────────────────────────────────────────────────

/** The exit code in a failed command’s result (“Exit code 2”), or null. */
export function exitCodeOf(text) {
  const m = /^(?:Error: )?Exit code (\d+)/m.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/** Links in a command’s or a tool’s output, at most five, each once. */
export function urlsIn(text) {
  const found = String(text ?? '').match(/https?:\/\/[^\s"'<>`)\]]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/, '')))].slice(0, 5);
}

const ARG = String.raw`([^\s;&|'"]+|'[^']*'|"[^"]*")`;
const unquote = (s) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');
// gh subcommands that write to the service: everything that creates, changes, comments or closes.
const GH_WRITES =
  /\bgh\s+(pr|issue|release|repo|gist|label|secret|variable|workflow|run)\s+(create|edit|comment|close|reopen|merge|review|ready|delete|develop|lock|unlock|pin|unpin|transfer|fork|rename|archive|upload|set|enable|disable|cancel|rerun)\b/g;

/**
 * What a command line did to version control and to services outside Postbox, read from the command and its
 * output. A commit and a push the tool result already reported (gitOperation) don’t need this; a branch, a gh
 * write and an API call with a write method do.
 * @returns {{ branches: string[], commit: { sha: string, branch: string, message: string } | null, push: { remote: string|null, refs: string[] } | null,
 *             external: { kind: 'gh' | 'api', what: string, urls: string[] }[] }}
 */
export function commandFacts(command, output = '') {
  const cmd = String(command ?? '');
  const out = String(output ?? '');
  const branches = new Set();
  // lint-allow regex: ARG is a constant pattern.
  for (const m of cmd.matchAll(new RegExp(String.raw`\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\s+(?:-b|-B|-c|-C|--create|--force-create)\s+${ARG}`, 'g')))
    branches.add(unquote(m[1]));
  // lint-allow regex: ARG is a constant pattern.
  for (const m of cmd.matchAll(new RegExp(String.raw`\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\s+(?:\S+\s+)*?-[bB]\s+${ARG}`, 'g'))) branches.add(unquote(m[1]));
  // lint-allow regex: ARG is a constant pattern.
  for (const m of cmd.matchAll(new RegExp(String.raw`\bgit\s+(?:-C\s+\S+\s+)?branch\s+(?!-)${ARG}`, 'g'))) branches.add(unquote(m[1]));
  const c = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,64})\] (.*)$/m.exec(out);
  const commit = /\bgit\b[^;&|]*\bcommit\b/.test(cmd) && c ? { branch: c[1], sha: c[2], message: c[3] } : null;
  const push = /\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(cmd)
    ? {
        remote: /^To (\S+)/m.exec(out)?.[1] ?? null,
        refs: [...out.matchAll(/^\s*[*+\-!= ]?\s*(\[new [a-z]+\]|[0-9a-f]{7,64}\.\.\.?[0-9a-f]{7,64})\s+(\S+)\s+->\s+(\S+)/gm)].map((m) => `${m[2]} → ${m[3]}`),
      }
    : null;
  const external = [];
  for (const m of cmd.matchAll(GH_WRITES)) external.push({ kind: /** @type {'gh'} */ ('gh'), what: `gh ${m[1]} ${m[2]}`, urls: urlsIn(out) });
  const api = /\bgh\s+api\b[^;&|]*?(?:-X|--method)\s+(POST|PATCH|PUT|DELETE)\b/i.exec(cmd);
  if (api) external.push({ kind: /** @type {'api'} */ ('api'), what: `gh api ${api[1].toUpperCase()}`, urls: urlsIn(out) });
  return { branches: [...branches], commit, push, external };
}

// MCP tool names whose verb writes to the service (create_pull_request, add_issue_comment, send_message…).
const WRITE_VERB =
  /^(?:create|update|add|edit|delete|remove|merge|push|post|send|comment|close|reopen|submit|write|upload|publish|request|assign|set|fork|resolve|archive|move|rename|share|trash|reply|enable|disable|run|trigger|cancel|approve|dismiss)(?:_|$)/;

/**
 * Whether a tool writes to a service outside Postbox: an MCP tool (not Postbox’s own) whose name starts with a
 * write verb. Returns { server, tool } or null.
 */
export function externalTool(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''));
  if (!m || m[1] === 'postbox') return null;
  return WRITE_VERB.test(m[2]) ? { server: m[1], tool: m[2] } : null;
}

// ── Totals ──────────────────────────────────────────────────────────────────────────────

/** Where a file can stand. Unchanged files (the agents put them back) count toward none of the summary’s totals. */
export const STATES = /** @type {const} */ (['uncommitted', 'committed', 'pushed', 'outside', 'unchanged']);
const zero = () => ({ files: 0, added: 0, deleted: 0 });
const add = (into, f) => {
  into.files += 1;
  into.added += f.added ?? 0;
  into.deleted += f.deleted ?? 0;
};
const sumTokens = (t) => (t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : 0);
const sum = (ts) => ({
  turns: ts.length,
  ms: ts.reduce((n, t) => n + (t.ms ?? 0), 0),
  toolCalls: ts.reduce((n, t) => n + (t.toolCalls ?? 0), 0),
  costUsd: ts.reduce((n, t) => n + (t.costUsd ?? 0), 0),
  tokens: ts.reduce((n, t) => n + sumTokens(t.tokens), 0),
  priced: ts.some((t) => typeof t.costUsd === 'number'),
});

/**
 * Where a file stands: the state git reports for it now, with “outside” for a file git doesn’t follow (outside a
 * repository, or ignored). Before git has answered, a file is uncommitted.
 */
export function fileState(file, git) {
  if (!lasting(file)) return 'unchanged';
  const s = git?.files?.[file.id]?.state;
  if (s === 'committed' || s === 'pushed' || s === 'uncommitted') return s;
  if (s === 'none' || s === 'ignored') return 'outside';
  if (s === 'unchanged') return 'unchanged';
  return 'uncommitted';
}
/**
 * Whether a file’s change is flagged for review: outside the project, or to a file that existed before and git can’t
 * give back. A file you restored is settled.
 */
export const flagged = (f, git) => !f.restored && (f.outside || (f.existed && (f.tracked === false || git?.files?.[f.id]?.state === 'none')));
/** Whether a file’s change survives: what the agents left differs from what was there before. */
export function lasting(f) {
  if (f.restored) return false;
  return (f.added ?? 0) > 0 || (f.deleted ?? 0) > 0 || Boolean(f.before?.exists) !== Boolean(f.after?.exists) || f.before?.sha256 !== f.after?.sha256;
}

/**
 * The ledger’s totals, for one conversation’s entries (state.work[conversationId]), optionally for one agent or one
 * turn. git is GET …/work/git’s answer, or null before it arrives.
 * @param {any[]} entries
 * @param {{ git?: any, handle?: string|null, turnId?: string|null }} [opts]
 */
export function summarize(entries, { git = null, handle = null, turnId = null } = {}) {
  const { byTurn, files: fileById } = ledgerIndex(entries ?? []);
  const scope = turnId ? (byTurn.get(turnId) ?? []) : (entries ?? []); // one turn’s summary reads its own entries (#618)
  const turns = scope.filter((e) => e.kind === 'turn' && (!handle || e.handle === handle) && (!turnId || e.id === turnId));
  const turnIds = new Set(turns.map((t) => t.id));
  const inScope = (e) => turnIds.has(e.turnId);
  const changes = scope.filter((e) => e.kind === 'change' && inScope(e));
  const changedFiles = new Set(changes.map((c) => c.fileId));
  // In one turn, a file shows what that turn did; otherwise, what all the agents’ turns left.
  const files = turnId
    ? changes.map((c) => ({ ...fileById.get(c.fileId), ...c, id: c.fileId, changeId: c.id }))
    : [...fileById.values()].filter((f) => !handle || changedFiles.has(f.id));
  const byState = Object.fromEntries(STATES.map((s) => [s, zero()]));
  const total = zero();
  for (const f of files) {
    const st = fileState(f, git);
    add(byState[st], f);
    // One turn’s total is what it did, even to a file put back since.
    if (turnId || st !== 'unchanged') add(total, f);
  }
  const of = (kind) => scope.filter((e) => e.kind === kind && inScope(e));
  const [commands, external, commits, pushes, branches, publishes, reads] = ['command', 'external', 'commit', 'push', 'branch', 'publish', 'read'].map(of);
  // Files an agent on a remote host edited (#120): named by the stream, never read, so they have no lines or state.
  const edits = of('edit');

  // Effort, per agent and in all. Lines a file keeps count toward the agent whose turn changed it last, so the
  // agents’ kept lines add up to the conversation’s.
  const agents = new Map();
  const agent = (h) => {
    if (!agents.has(h))
      agents.set(h, { handle: h, turns: 0, ms: 0, toolCalls: 0, costUsd: 0, tokens: 0, commands: 0, failed: 0, written: 0, writtenDel: 0, ...zero() });
    return agents.get(h);
  };
  for (const t of turns) {
    const a = agent(t.handle);
    a.turns += 1;
    a.ms += t.ms ?? 0;
    a.toolCalls += t.toolCalls ?? 0;
    a.costUsd += t.costUsd ?? 0;
    a.tokens += sumTokens(t.tokens);
  }
  for (const c of changes) {
    const a = agent(c.handle);
    a.written += c.added ?? 0;
    a.writtenDel += c.deleted ?? 0;
  }
  for (const f of files) if (turnId || !handle || f.lastHandle === handle) add(agent(turnId ? f.handle : f.lastHandle), f);
  for (const c of commands) {
    const a = agent(c.handle);
    a.commands += 1;
    if (c.state === 'failed') a.failed += 1;
  }

  // Turns that tried something (changed a file or ran a command) and left nothing lasting: no change, publish, commit,
  // push or write outside Postbox. A turn whose change a later one put back still has it in its list (#195). An edit
  // on a host may have lasted: Postbox can’t tell, so it doesn’t call that turn idle (#120).
  const lastingTurn = new Set([...changes, ...commits, ...pushes, ...external, ...publishes, ...edits].map((e) => e.turnId));
  const tried = new Set([...changes, ...commands].map((e) => e.turnId));
  const idle = turns.filter((t) => tried.has(t.id) && !lastingTurn.has(t.id));
  return {
    files,
    total,
    byState,
    byAgent: [...agents.values()].sort((a, b) => b.added + b.deleted - (a.added + a.deleted) || b.turns - a.turns),
    commands,
    external,
    commits,
    pushes,
    branches,
    publishes,
    reads,
    edits,
    turns,
    effort: { ...sum(turns), written: changes.reduce((n, c) => n + (c.added ?? 0), 0), kept: total.added },
    idle: { ...sum(idle), list: idle },
    flagged: files.filter((f) => flagged(f, git)).length,
  };
}

/** The effort that went into one file: the turns that changed it. */
export function fileEffort(entries, fileId) {
  const ids = new Set((entries ?? []).filter((e) => e.kind === 'change' && e.fileId === fileId).map((c) => c.turnId));
  const ts = (entries ?? []).filter((e) => e.kind === 'turn' && ids.has(e.id));
  return {
    turns: ts.length,
    ms: ts.reduce((n, t) => n + (t.ms ?? 0), 0),
    costUsd: ts.reduce((n, t) => n + (t.costUsd ?? 0), 0),
    priced: ts.some((t) => typeof t.costUsd === 'number'),
  };
}

/**
 * An item carrying a turn’s list that moves to the newest point (an app a later turn updates, #49): the stub left in
 * its place keeps the list, where that turn ended, and the item carries none (#195).
 */
export function carriedList(it) {
  if (!it?.work) return { stub: {}, item: {} };
  return { stub: { work: it.work, workTurn: it.workTurn ?? it.turnId }, item: { work: null, workTurn: null } };
}

/** One turn’s line for the transcript (“3 files +40 −12 · 2 commands · $0.31”), or null when it did no work. */
export function turnLine(entries, turnId) {
  const s = summarize(entries, { turnId });
  if (!s.files.length && !s.edits.length && !s.commands.length && !s.external.length && !s.commits.length && !s.publishes.length && !s.reads.length)
    return null;
  const parts = [];
  if (s.files.length) parts.push(`${s.files.length === 1 ? '1 file' : `${s.files.length} files`} ${signed(s.total.added, s.total.deleted)}`);
  if (s.edits.length) parts.push(`${s.edits.length === 1 ? '1 file' : `${s.edits.length} files`} edited on ${s.edits[0].host?.name ?? 'a host'}`);
  if (s.commands.length) {
    const failed = s.commands.filter((c) => c.state === 'failed').length;
    parts.push(`${s.commands.length === 1 ? '1 command' : `${s.commands.length} commands`}${failed ? ` (${failed} failed)` : ''}`);
  }
  const apps = s.publishes.filter((p) => p.what === 'app').length;
  if (apps) parts.push(apps === 1 ? '1 app' : `${apps} apps`);
  if (s.publishes.length > apps) parts.push(s.publishes.length - apps === 1 ? '1 block' : `${s.publishes.length - apps} blocks`);
  if (s.commits.length) parts.push(s.commits.length === 1 ? '1 commit' : `${s.commits.length} commits`);
  if (s.external.length) parts.push(`${s.external.length} outside Postbox`);
  if (s.reads.length && parts.length === 0) parts.push(readsLine(s.reads));
  // The turn’s elapsed time, said as such: the reply’s activity line sums its tool steps instead (#214).
  if (s.effort.ms >= 100) parts.push(`${formatDuration(s.effort.ms)} in all`);
  if (s.effort.priced) parts.push(formatCost(s.effort.costUsd));
  return parts.join(' · ');
}

// ── Words ───────────────────────────────────────────────────────────────────────────────

/** “Read 15 files · fetched 3 pages · 2 searches” (#195). */
export function readsLine(reads) {
  const n = (...tools) => reads.filter((r) => tools.includes(r.tool)).length;
  const [files, pages, searches] = [n('Read'), n('WebFetch'), n('Grep', 'Glob', 'WebSearch')];
  const text = [
    files ? `read ${files === 1 ? '1 file' : `${files} files`}` : '',
    pages ? `fetched ${pages === 1 ? '1 page' : `${pages} pages`}` : '',
    searches ? (searches === 1 ? '1 search' : `${searches} searches`) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const num = (n) => Math.round(n).toLocaleString('en-US');
/** “+612 −0”, with a real minus sign. */
export const signed = (added, deleted) => `+${num(added ?? 0)} −${num(deleted ?? 0)}`;
/** “$0.31”, “<$0.01”, “$14.20”. */
export function formatCost(usd) {
  const n = Number(usd) || 0;
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
/** “840”, “84 k”, “1.2 M” tokens. */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${Math.round(v / 1000)} k`;
  return `${(v / 1e6).toFixed(1)} M`;
}
/** “1.2 KB”, “3.4 MB”, “120 bytes”. */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1000) return `${v} ${v === 1 ? 'byte' : 'bytes'}`;
  if (v < 1e6) return `${(v / 1000).toFixed(1)} KB`;
  return `${(v / 1e6).toFixed(1)} MB`;
}
