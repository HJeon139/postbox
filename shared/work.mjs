// The work ledger (#132): what a conversation’s agents changed, ran and published, and what it took. These are
// the pure parts the server (server/ledger.mjs) and the Work view (app/js/work.mjs) share: line counts from a
// diff, what a command line did to version control and to services outside Postbox, and the totals.

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

// ── Diffs ───────────────────────────────────────────────────────────────────────────────

/** Whether bytes look binary, as git decides: a NUL in the first 8,000 bytes. */
export function isBinary(bytes) {
  const n = Math.min(bytes?.length ?? 0, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// The last line without a newline is a different line from the same text with one, so adding the final newline
// counts as one line deleted and one added, as git counts it.
const NOEOL = '\u0000';
/** A text’s lines, the way a diff sees them. */
export function splitLines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const lines = s.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else lines[lines.length - 1] += NOEOL;
  return lines;
}
const shown = (t) => (t.endsWith(NOEOL) ? t.slice(0, -1) : t);

/** The number of lines two texts share at their start and at their end. */
function trim(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/**
 * The shortest edit script’s length between two line arrays (Myers), or -1 past `max`. Only the length: lines added
 * and deleted follow from it and the two lengths, so counting needs no path and little memory.
 */
function editDistance(a, b, max) {
  const n = a.length;
  const m = b.length;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return -1;
}

/**
 * Lines added and deleted between two texts, as `git diff --numstat` counts them.
 * @returns {{ added: number, deleted: number }}
 */
export function diffCount(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const { pre, suf } = trim(a, b);
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  if (!ma.length || !mb.length) return { added: mb.length, deleted: ma.length };
  // Past this many edits, a minimal script costs more than it tells: count the middle as replaced.
  const d = editDistance(ma, mb, Math.min(ma.length + mb.length, 5000));
  if (d < 0) return { added: mb.length, deleted: ma.length };
  return { added: (d + mb.length - ma.length) / 2, deleted: (d - mb.length + ma.length) / 2 };
}

/**
 * A line diff to show: rows of { t, kind: 'same' | 'add' | 'del', o?, n? }, where o and n are line numbers in the
 * old and new text. It is minimal (Myers) when the texts differ by at most `maxEdits` lines, and otherwise shows
 * the changed middle as removed, then added.
 */
export function diffRows(before, after, { maxEdits = 2000 } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  const { pre, suf } = trim(a, b);
  const rows = [];
  for (let i = 0; i < pre; i++) rows.push({ t: shown(a[i]), kind: 'same', o: i + 1, n: i + 1 });
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const middle = myersPath(ma, mb, maxEdits);
  if (middle)
    for (const r of middle)
      rows.push(
        r.kind === 'same'
          ? { t: shown(mb[r.j]), kind: 'same', o: pre + r.i + 1, n: pre + r.j + 1 }
          : r.kind === 'del'
            ? { t: shown(ma[r.i]), kind: 'del', o: pre + r.i + 1 }
            : { t: shown(mb[r.j]), kind: 'add', n: pre + r.j + 1 },
      );
  else {
    for (let i = 0; i < ma.length; i++) rows.push({ t: shown(ma[i]), kind: 'del', o: pre + i + 1 });
    for (let j = 0; j < mb.length; j++) rows.push({ t: shown(mb[j]), kind: 'add', n: pre + j + 1 });
  }
  for (let s = 0; s < suf; s++) {
    const i = a.length - suf + s;
    const j = b.length - suf + s;
    rows.push({ t: shown(b[j]), kind: 'same', o: i + 1, n: j + 1 });
  }
  return rows;
}

/** Myers with its trace, for a diff to show; null when the texts differ by more than max lines. */
function myersPath(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  const limit = Math.min(n + m, max);
  const off = limit + 1;
  const trace = [];
  const v = new Int32Array(2 * limit + 3);
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  // Walk back from the end through each step’s saved row.
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const row = trace[d]; // v as it was before step d, from k = -d-1 to d+1
    const at = (k) => row[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push({ kind: 'same', i: --x, j: --y });
    if (x === prevX) out.push({ kind: 'add', j: --y });
    else out.push({ kind: 'del', i: --x });
  }
  while (x > 0 && y > 0) out.push({ kind: 'same', i: --x, j: --y });
  return out.reverse();
}

/**
 * Rows grouped into hunks with `context` unchanged lines around each change; a run of unchanged lines between them
 * becomes { kind: 'gap', skipped }.
 */
export function hunks(rows, context = 3) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = 1;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'gap', skipped });
      skipped = 0;
      out.push(r);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: 'gap', skipped });
  return out;
}

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
  for (const m of cmd.matchAll(new RegExp(String.raw`\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\s+(?:-b|-B|-c|-C|--create|--force-create)\s+${ARG}`, 'g')))
    branches.add(unquote(m[1]));
  for (const m of cmd.matchAll(new RegExp(String.raw`\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\s+(?:\S+\s+)*?-[bB]\s+${ARG}`, 'g'))) branches.add(unquote(m[1]));
  for (const m of cmd.matchAll(new RegExp(String.raw`\bgit\s+(?:-C\s+\S+\s+)?branch\s+(?!-)${ARG}`, 'g'))) branches.add(unquote(m[1]));
  const c = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.*)$/m.exec(out);
  const commit = /\bgit\b[^;&|]*\bcommit\b/.test(cmd) && c ? { branch: c[1], sha: c[2], message: c[3] } : null;
  const push = /\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(cmd)
    ? {
        remote: /^To (\S+)/m.exec(out)?.[1] ?? null,
        refs: [...out.matchAll(/^\s*[*+\-!= ]?\s*(\[new [a-z]+\]|[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/gm)].map((m) => `${m[2]} → ${m[3]}`),
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
  const list = entries ?? [];
  const turns = list.filter((e) => e.kind === 'turn' && (!handle || e.handle === handle) && (!turnId || e.id === turnId));
  const turnIds = new Set(turns.map((t) => t.id));
  const inScope = (e) => turnIds.has(e.turnId);
  const changes = list.filter((e) => e.kind === 'change' && inScope(e));
  const changedFiles = new Set(changes.map((c) => c.fileId));
  const fileById = new Map(list.filter((e) => e.kind === 'file').map((f) => [f.id, f]));
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
  const of = (kind) => list.filter((e) => e.kind === kind && inScope(e));
  const commands = of('command');
  const external = of('external');
  const commits = of('commit');
  const pushes = of('push');
  const branches = of('branch');

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

  // Turns that tried something (changed a file or ran a command) and left nothing lasting: no change that
  // survives, no commit, push or write outside Postbox.
  const lastingTurn = new Set();
  for (const c of changes)
    if (lasting(fileById.get(c.fileId) ?? {}) && (c.added || c.deleted || c.before?.sha256 !== c.after?.sha256)) lastingTurn.add(c.turnId);
  for (const e of [...commits, ...pushes, ...external]) lastingTurn.add(e.turnId);
  const tried = new Set([...changes, ...commands].map((e) => e.turnId));
  const idle = turns.filter((t) => tried.has(t.id) && !lastingTurn.has(t.id));

  const sum = (ts) => ({
    turns: ts.length,
    ms: ts.reduce((n, t) => n + (t.ms ?? 0), 0),
    toolCalls: ts.reduce((n, t) => n + (t.toolCalls ?? 0), 0),
    costUsd: ts.reduce((n, t) => n + (t.costUsd ?? 0), 0),
    tokens: ts.reduce((n, t) => n + sumTokens(t.tokens), 0),
    priced: ts.some((t) => typeof t.costUsd === 'number'),
  });
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

/** One turn’s line for the transcript (“3 files +40 −12 · 2 commands · $0.31”), or null when it did no work. */
export function turnLine(entries, turnId) {
  const s = summarize(entries, { turnId });
  if (!s.files.length && !s.commands.length && !s.external.length && !s.commits.length) return null;
  const parts = [];
  if (s.files.length) parts.push(`${s.files.length === 1 ? '1 file' : `${s.files.length} files`} ${signed(s.total.added, s.total.deleted)}`);
  if (s.commands.length) {
    const failed = s.commands.filter((c) => c.state === 'failed').length;
    parts.push(`${s.commands.length === 1 ? '1 command' : `${s.commands.length} commands`}${failed ? ` (${failed} failed)` : ''}`);
  }
  if (s.commits.length) parts.push(s.commits.length === 1 ? '1 commit' : `${s.commits.length} commits`);
  if (s.external.length) parts.push(`${s.external.length} outside Postbox`);
  if (s.effort.priced) parts.push(formatCost(s.effort.costUsd));
  return parts.join(' · ');
}

// ── Words ───────────────────────────────────────────────────────────────────────────────

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
