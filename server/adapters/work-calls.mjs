// The tool calls of backends other than Claude Code, for the work ledger (#132, #545). server/ledger.mjs reads calls in
// Claude Code’s names (shared/work.mjs): a file change is Edit or Write with its file_path, a command is Bash with its
// command, and an MCP tool is mcp__<server>__<tool>. Without these, Work showed nothing a Codex or Antigravity agent
// changed or ran, and their replies had no work line.

import { readFileSync } from 'node:fs';

/**
 * The command inside a shell’s -lc wrapper, which Codex puts around every command it runs (recorded:
 * /bin/zsh -lc 'git status --short'), so Work shows what the agent asked for and reads git and gh in it.
 * Anything else comes back as it was.
 * @param {unknown} command @returns {string}
 */
export function unwrapShell(command) {
  const s = String(command ?? '');
  const m = /^(?:\S*\/)?(?:ba|z)?sh -lc ([\s\S]+)$/.exec(s);
  if (!m) return s;
  const arg = m[1];
  if (/^'[\s\S]*'$/.test(arg)) return arg.slice(1, -1).replaceAll(`'\\''`, `'`);
  if (/^"[\s\S]*"$/.test(arg)) return arg.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return s;
}

/**
 * A file as it was before a patch, from the file after it and the patch’s unified diff, or null when they don’t agree
 * (the file changed again since). Codex reports a change as a diff and writes it within milliseconds of saying it
 * started (recorded: 46 ms), so reading the file when it starts can already find the new contents.
 * @param {string} after @param {string} diff @returns {string|null}
 */
export function beforePatch(after, diff) {
  const lines = after.split('\n');
  const out = [];
  let at = 0;
  let inHunk = false;
  for (const row of String(diff).split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (h) {
      // A hunk that adds nothing names the line before it.
      const start = h[2] === '0' ? Number(h[1]) : Math.max(Number(h[1]) - 1, 0);
      if (start < at || start > lines.length) return null;
      out.push(...lines.slice(at, start));
      at = start;
      inHunk = true;
      continue;
    }
    if (!inHunk || row === '' || row.startsWith('\\')) continue;
    const text = row.slice(1);
    if (row[0] === '-') out.push(text);
    else if (row[0] === '+' || row[0] === ' ') {
      if (lines[at] !== text) return null;
      if (row[0] === ' ') out.push(text);
      at += 1;
    } else return null;
  }
  return [...out, ...lines.slice(at)].join('\n');
}

/**
 * What an Antigravity tool step returned, for ctx.toolResult. A command’s output starts with its exit (recorded:
 * “Command exited with code 0.\n\nCommand output:\n …”, with \r\n line ends), which becomes Claude Code’s “Exit code N”.
 * @param {string} id @param {any} step agy’s step_update @param {boolean} failed the step ended in ERROR
 */
export function agyResult(id, step, failed) {
  const raw = String(step?.tool_info?.output ?? '').replace(/\r\n/g, '\n');
  if (failed) return { id, isError: true, text: String(step?.tool_info?.error?.message ?? raw) };
  const m = /^Command exited with code (-?\d+)\.\n*(?:Command output:\n)?([\s\S]*)$/.exec(raw);
  if (!m) return { id, isError: false, text: raw };
  const exit = Number(m[1]);
  return { id, isError: exit !== 0, text: exit !== 0 ? `Exit code ${exit}` : '', result: { stdout: m[2] } };
}
