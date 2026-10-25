// Which permission rule decides a tool call, in Claude Code’s order: deny, then ask, then allow, then the mode
// (#66). The permissions panel’s effective view runs this as you type, so it’s shared with the browser and pure.
//
// The rule forms are the ones Claude Code documents (code.claude.com/docs/en/iam, “Permission rule syntax”):
// - a tool on its own (`Bash`, `WebFetch`), or with `(*)`, matches every use of it;
// - Bash: `Bash(npm run build)` exactly; `Bash(npm test:*)` the command and anything after it; `Bash(git * main)`
//   a glob, where `*` is any text and `ls *` (a space before the star) needs a word break, so it doesn’t match lsof.
//   A command that chains (&&, ||, ;, |, &, a command substitution) is split as the shell reads it
//   (command-chains.mjs): a deny or ask rule that matches any part decides, and an allow rule has to cover every part;
// - WebFetch: `WebFetch(domain:example.com)` the host, `domain:*.example.com` its subdomains too;
// - Read and Edit: gitignore-style paths. `//abs` is absolute, `~/x` is under the home folder, `/x` is under the
//   settings file’s folder (the agent’s folder; the home folder for user settings), and `x` or `./x` under the
//   folder it works in. `*` stays in one folder, `**` crosses folders, and a pattern without a slash matches a
//   name at any depth. Edit rules cover every tool that changes files, Read rules every tool that reads them;
// - MCP: `mcp__server` (or `mcp__server__*`) every tool of the server, `mcp__server__tool` one tool;
// - anything else, such as `Agent(Explore)`: the tool, and its specifier exactly.
// Claude Code has the final say: hooks, managed settings and its own checks (paths outside the working folders,
// auto mode’s safety check) aren’t in here, and the panel says so.

import { splitCommand } from './command-chains.mjs';

export { splitCommand };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
// Tools Claude Code’s default (ask) mode runs without asking: they only read.
const READ_ONLY = new Set([...READ_TOOLS, 'TodoWrite', 'Task', 'Agent', 'ToolSearch', 'TaskOutput']);

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * A rule’s parts: `Bash(npm test:*)` → { tool: 'Bash', spec: 'npm test:*' }; `Bash` → { tool: 'Bash', spec: null }.
 * @param {string} rule
 */
export function parseRule(rule) {
  const m = String(rule ?? '')
    .trim()
    .match(/^([^(]+?)(?:\((.*)\))?$/s);
  if (!m) return { tool: '', spec: null };
  const spec = m[2] === undefined || m[2] === '*' || m[2] === '' ? null : m[2];
  return { tool: m[1].trim(), spec };
}

/**
 * A call as typed in the effective view, in the rule syntax: `Bash(npm test)`, `WebFetch(https://example.com/x)`,
 * `Read(src/a.js)`, `mcp__github__create_issue`. Returns { tool, arg }, arg null when none was given.
 * @param {string} text
 */
export function parseCall(text) {
  const { tool, spec } = parseRule(text);
  const m = String(text ?? '')
    .trim()
    .match(/^[^(]+\((.*)\)$/s);
  return { tool, arg: m ? m[1] : spec };
}

/** Whether a tool name matches a rule’s tool part, which may be a glob or a whole MCP server. */
function toolMatches(ruleTool, tool) {
  if (ruleTool === tool) return true;
  if (/^mcp__[^_*]+(?:_[^_*]+)*$/.test(ruleTool) && !ruleTool.slice(5).includes('__')) return tool.startsWith(`${ruleTool}__`);
  if (ruleTool.includes('*')) return new RegExp(`^${escapeRe(ruleTool).replace(/\\\*/g, '.*').replace(/\*/g, '.*')}$`).test(tool);
  return false;
}

/** A Bash specifier against one simple command. */
function bashMatches(spec, cmd) {
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2);
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  if (!spec.includes('*')) return cmd === spec;
  // `ls *` also matches `ls` on its own; `ls*` matches lsof too.
  let src = escapeRe(spec).replace(/\*/g, '.*');
  if (src.endsWith(' .*')) src = `${src.slice(0, -3)}(?: .*)?`;
  return new RegExp(`^${src}$`, 's').test(cmd);
}

/** A glob over a path: `*` and `?` within one folder, `**` across folders. */
function globRegex(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        i++;
        src += '(?:.*/)?';
      } else src += '.*';
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += escapeRe(c);
  }
  return new RegExp(`^${src}$`);
}

const join = (a, b) => `${a.replace(/\/+$/, '')}/${b.replace(/^\.?\/+/, '')}`;
/** A path made absolute and tidy: relative to base, with ./ and ../ resolved. */
function absolute(path, base) {
  const p = String(path).startsWith('/') ? String(path) : join(base, String(path));
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return `/${out.join('/')}`;
}

/**
 * A Read or Edit path rule against a file path.
 * @param {string} spec @param {string} path @param {{ cwd: string, home: string, root: string }} where
 */
function pathMatches(spec, path, { cwd, home, root }) {
  const file = absolute(path.startsWith('~/') ? join(home, path.slice(2)) : path, cwd);
  let pattern;
  if (spec.startsWith('//')) pattern = spec.slice(1);
  else if (spec.startsWith('~/')) pattern = join(home, spec.slice(2));
  else if (spec.startsWith('/')) pattern = join(root, spec.slice(1));
  else if (!spec.replace(/^\.\//, '').includes('/')) {
    // A name without a folder matches at any depth, as in .gitignore.
    const name = spec.replace(/^\.\//, '');
    return globRegex(name).test(file.split('/').at(-1) ?? '') || globRegex(`**/${name}`).test(file.slice(1));
  } else pattern = join(cwd, spec);
  // ** has to survive the tidying, which only splits on slashes and drops . and .. segments.
  pattern = absolute(pattern, '/');
  if (pattern.endsWith('/')) pattern += '**';
  return globRegex(pattern).test(file) || (spec.endsWith('/**') && file === pattern.slice(0, -3));
}

/** The host of a URL, or null. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
}

/**
 * Whether a rule covers a call (for Bash, one simple command of it).
 * @param {string} rule @param {{ tool: string, arg: string|null }} call
 * @param {{ cwd: string, home: string, root?: string }} where
 */
export function ruleMatches(rule, call, where) {
  const r = parseRule(rule);
  const tool = call.tool;
  const as = EDIT_TOOLS.has(tool) && r.tool === 'Edit' ? 'Edit' : READ_TOOLS.has(tool) && r.tool === 'Read' ? 'Read' : null;
  if (!as && !toolMatches(r.tool, tool)) return false;
  if (r.spec === null) return true;
  if (call.arg === null || call.arg === undefined) return false;
  const arg = String(call.arg).trim();
  const kind = as ?? r.tool;
  if (kind === 'Bash') return bashMatches(r.spec, arg);
  if (kind === 'WebFetch' && r.spec.startsWith('domain:')) {
    const host = hostOf(arg) ?? hostOf(`https://${arg}`);
    const want = r.spec.slice(7).toLowerCase();
    if (!host) return false;
    return want.startsWith('*.') ? host === want.slice(2) || host.endsWith(want.slice(1)) : host === want;
  }
  if (kind === 'Read' || kind === 'Edit') return pathMatches(r.spec, arg, { root: where.root ?? where.cwd, ...where });
  return r.spec === arg;
}

/**
 * Whether an allow rule lets a write outside Postbox past Postbox’s check without a card (#112, server/write-guard.mjs):
 * one that names the MCP tool itself, as Always allow saves it, not its whole server, which may be allowed for its
 * reads; for Bash, one with a command pattern that covers this command, not Bash on its own.
 * @param {string} rule @param {{ tool: string, arg: string|null }} call @param {{ cwd: string, home: string, root?: string }} where
 */
export function passesWriteCheck(rule, call, where) {
  const r = parseRule(rule);
  if (call.tool === 'Bash') return r.tool === 'Bash' && r.spec !== null && ruleMatches(rule, call, where);
  return r.tool === call.tool && r.spec === null;
}

/**
 * @typedef {{ rule: string, source: string, root?: string, unless?: string[] }} SourcedRule
 *   source says where the rule comes from: user, project, local, conversation, tools (the persona’s Tools), postbox,
 *   writes (Postbox’s ask rules for writes outside it, #112). root is where a `/path` rule starts (the folder of the
 *   settings file it’s in). unless: for a writes rule, the tools it doesn’t ask about (those the persona may publish).
 * @typedef {{ decision: 'deny'|'ask'|'allow'|'mode', rule?: string, source?: string, part?: string, mode?: string,
 *             outcome: 'refused'|'asks'|'runs'|'decides' }} Verdict
 */

/** What a permission mode does with a call no rule decides. */
function byMode(mode, tool) {
  if (mode === 'bypass') return 'runs';
  if (mode === 'auto') return 'decides';
  if (READ_ONLY.has(tool)) return 'runs';
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return 'runs';
  return 'asks';
}

/**
 * Which rule decides a call: deny first, then ask, then allow, then the mode (Postbox’s names: auto, ask,
 * acceptEdits, bypass).
 * @param {{ call: string, rules: { deny: SourcedRule[], ask: SourcedRule[], allow: SourcedRule[] }, mode: string,
 *           cwd: string, home: string }} opts
 * @returns {Verdict}
 */
export function decide({ call, rules, mode, cwd, home }) {
  const c = parseCall(call);
  const parts = c.tool === 'Bash' && c.arg ? splitCommand(c.arg) : [c.arg];
  const calls = (parts.length ? parts : [c.arg]).map((arg) => ({ tool: c.tool, arg }));
  const at = (r) => ({ cwd, home, root: r.root ?? cwd });
  // A writes ask rule doesn’t ask about a call the person settled: Always allowed, or one the persona may publish.
  // Postbox’s own tools are never held as writes (server/write-guard.mjs).
  const settled = (r, cl) =>
    r.source === 'writes' &&
    (cl.tool.startsWith('mcp__postbox__') ||
      (r.unless ?? []).some((u) => ruleMatches(u, cl, at(r))) ||
      rules.allow.some((a) => passesWriteCheck(a.rule, cl, at(a))));
  const hit = (list, cl) => list.find((r) => ruleMatches(r.rule, cl, at(r)) && !settled(r, cl));
  for (const behavior of /** @type {const} */ (['deny', 'ask'])) {
    for (const cl of calls) {
      const r = hit(rules[behavior], cl);
      if (r)
        return {
          decision: behavior,
          rule: r.rule,
          source: r.source,
          ...(calls.length > 1 ? { part: String(cl.arg) } : {}),
          outcome: behavior === 'deny' ? 'refused' : 'asks',
        };
    }
  }
  const allowed = calls.map((cl) => hit(rules.allow, cl));
  if (allowed.every(Boolean)) return { decision: 'allow', rule: allowed[0]?.rule, source: allowed[0]?.source, outcome: 'runs' };
  const left = calls.find((_, i) => !allowed[i]);
  return { decision: 'mode', mode, outcome: byMode(mode, c.tool), ...(calls.length > 1 ? { part: String(left?.arg) } : {}) };
}
