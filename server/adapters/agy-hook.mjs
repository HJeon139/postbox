#!/usr/bin/env node
// Antigravity CLI PreToolUse hook (#370): runs before every tool call when agy starts with
// --dangerously-skip-permissions in Ask me, Auto or Accept edits. It allows safe calls for the mode, denies edits to
// Postbox’s plugin, this script or ~/.gemini/antigravity-cli, and asks the person through Postbox’s permission_prompt
// MCP tool for the rest. In Auto it also allows routine commands, gh’s issue and pull request commands, web searches
// and public fetches, and MCP tools outside Postbox (server/adapters/agy-auto.mjs), and asks before an edit in .git.
// Fails closed to { decision: "deny", reason } on any error; never outputs ask, force_ask or empty stdout, which agy
// fails open on under --dangerously-skip-permissions.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_WAIT_MS } from '../permission-cards.mjs';
import { autoAllows, inGit, personaAllows, personaOf, publishingCall } from './agy-auto.mjs';
import { inside, leadsInto, PATH_FIELDS, pathArgs, readingsOf, realTarget } from './agy-paths.mjs';
import { POSTBOX_SERVER } from './setup.mjs';

export const HOOK_SCRIPT = fileURLToPath(import.meta.url);
/** Outlasts Postbox’s card wait (CARD_WAIT_MS) so an unanswered card expires to deny before agy times the hook out. */
export const HOOK_TIMEOUT_S = Math.ceil(CARD_WAIT_MS / 1000) + 60;
/** How Antigravity asks (adapter.mjs’s capabilities): through permission_prompt, from this hook, by an id no stream line carries (#353). */
export const HOOK_PROMPTS = Object.freeze({ promptTool: true, promptHook: true });

const WRITE_TOOLS = new Set(['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content']);
const READ_TOOLS = new Set(['read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search']);
// agy’s own folders a model reads with no card: its MCP tools’ schemas and its notes (agy-tools.mjs’s AGY_FILE), and
// its builtin skills and guide, which a model read unprompted in a UAT: a card nobody can usefully judge (#1074).
const AGY_READABLE = ['mcp', 'brain', 'builtin'];
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'send_message', 'manage_subagents', 'manage_task']);
// A command that names Antigravity’s plugin, this hook or agy’s settings: always a card, flagged.
const PROTECTED_CMD = /\.agents\b|agy-hook\.mjs\b|\.gemini[\\/]antigravity-cli\b/i;
const PUBLISH_OFF = 'This agent can’t publish outside Postbox (its persona’s “Can publish outside Postbox” is off), so Postbox refused this tool.';

/** Whether an agy version supports PreToolUse hooks (1.4.7 and newer). */
export function agySupportsHooks(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj > 1 || (maj === 1 && (min > 4 || (min === 4 && patch >= 7)));
}

/** The hook script’s path when it’s safe to pass to agy’s `/bin/sh -c` runner, or null if it has shell characters. */
export const agyHookCommand = (script = HOOK_SCRIPT) => (typeof script === 'string' && script.startsWith('/') && !/[^\w./:@+-]/.test(script) ? script : null);

/** The plugin’s hooks.json content for a turn. */
export const agyHooksJson = (command = agyHookCommand(), timeout = HOOK_TIMEOUT_S) => ({
  [POSTBOX_SERVER]: {
    PreToolUse: [{ matcher: '*', hooks: [{ command, timeout }] }],
  },
});

/**
 * Confirms that PreToolUse hooks will run before passing --dangerously-skip-permissions: an agy version with hooks,
 * a safe existing hook script path, and hooks.json written and read back intact.
 * @param {{ version: string|null|undefined, pluginDir: string, script?: string, timeout?: number }} opts
 */
export async function confirmAgyHook({ version, pluginDir, script = HOOK_SCRIPT, timeout = HOOK_TIMEOUT_S }) {
  if (!agySupportsHooks(version)) return false;
  const command = agyHookCommand(script);
  if (!command) return false;
  const st = await stat(script).catch(() => null);
  if (!st?.isFile()) return false;
  const expected = `${JSON.stringify(agyHooksJson(command, timeout), null, 2)}\n`;
  const actual = await readFile(join(pluginDir, 'hooks.json'), 'utf8').catch(() => '');
  return actual === expected;
}

/**
 * Whether a path points at Postbox’s plugin, this hook script, or ~/.gemini/antigravity-cli (directly or via symlink).
 * Compared without case: macOS’s file system ignores it, so .AGENTS/plugins is .agents/plugins there (#423’s review).
 */
export function isProtectedPath(rawPath, { cwd = process.cwd(), scriptPath = HOOK_SCRIPT, home = homedir() } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return true;
  return readingsOf(rawPath, cwd, home).some((at) => protectedAt(at, { scriptPath, home }));
}

/** Whether one absolute path, as written or where it leads, is one isProtectedPath protects. */
function protectedAt(at, { scriptPath, home }) {
  const abs = resolve(at).toLowerCase();
  const real = (realTarget(at, '/') ?? abs).toLowerCase();
  const pluginRe = /(?:^|[\\/])\.agents(?:[\\/]plugins(?:[\\/]|$)|$)/;
  if (pluginRe.test(abs) || pluginRe.test(real)) return true;
  const realScript = (realTarget(scriptPath, '/') ?? resolve(scriptPath)).toLowerCase();
  if (abs === resolve(scriptPath).toLowerCase() || real === realScript) return true;
  const agyDir = resolve(home, '.gemini', 'antigravity-cli');
  const realAgyDir = realTarget(agyDir, '/') ?? agyDir;
  return inside(abs, agyDir.toLowerCase()) || inside(real, realAgyDir.toLowerCase());
}

/**
 * Classifies one Antigravity tool call for the persona’s mode: 'allow', 'deny' (with reason), or 'ask' (with the
 * Claude Code toolName and input that Postbox’s permission card expects).
 * @param {any} event
 * @param {{ mode?: string, folders?: string[], readFolders?: string[], cwd?: string, scriptPath?: string, home?: string, tools?: string[], canPublish?: boolean }} [opts]
 *   tools and canPublish: the persona’s (agy-auto.mjs, personaOf, #416); readFolders: folders it may only read (#338),
 *   which the read branch counts and an edit or Auto’s routine calls never do
 */
export function decideAgyTool(
  event,
  { mode = 'ask', folders = [], readFolders = [], cwd = process.cwd(), scriptPath = HOOK_SCRIPT, home = homedir(), tools = [], canPublish = false } = {},
) {
  const name = String(event?.toolCall?.name ?? '').trim();
  const args = event?.toolCall?.args && typeof event.toolCall.args === 'object' ? event.toolCall.args : {};
  if (!name) return { decision: 'deny', reason: 'Postbox’s Antigravity hook received no tool name.' };
  const mcp = name === 'call_mcp_tool' || name === 'list_resources' || name === 'read_resource';
  const server = String(args.ServerName ?? '');
  const tool = String(args.ToolName ?? '');
  if (mcp && (server === 'postbox_postbox' || server === 'postbox') && tool === 'permission_prompt')
    return { decision: 'deny', reason: 'Postbox’s permission_prompt tool is only for the PreToolUse hook.' };
  if (!canPublish && publishingCall(name, args)) return { decision: 'deny', reason: PUBLISH_OFF };
  const roots = /** @type {string[]} */ ((folders.length ? folders : [cwd]).map((f) => realTarget(f, cwd)).filter(Boolean));
  const command = name === 'run_command' ? String(args.CommandLine ?? '') : '';
  const isProtected = (p) => isProtectedPath(p, { cwd, scriptPath, home });
  // In Auto, Postbox approves routine calls and what the persona’s tools allow (agy-auto.mjs, #416); a command naming
  // Antigravity’s files asks.
  if (
    mode === 'auto' &&
    !PROTECTED_CMD.test(command) &&
    (autoAllows(name, args, { roots, cwd, home, isProtected, realTarget }) || personaAllows(name, args, tools))
  )
    return { decision: 'allow' };
  if (mcp) {
    if (server === 'postbox_postbox') return { decision: 'allow' };
    const input = args.Arguments && typeof args.Arguments === 'object' ? args.Arguments : {};
    return { decision: 'ask', toolName: `mcp__${server || 'mcp'}__${tool || name}`, input };
  }
  if (SUBAGENT_TOOLS.has(name)) return { decision: 'allow' };
  if (WRITE_TOOLS.has(name)) return decideWrite(name, args, { mode, roots, cwd, scriptPath, home });
  if (READ_TOOLS.has(name)) return decideRead(args, { roots, readFolders, cwd, home });
  if (name === 'run_command') {
    const summary = String(args.toolSummary ?? '').trim();
    const warn = PROTECTED_CMD.test(command) ? 'Touches Antigravity’s plugin, hook or settings' : '';
    const description = warn && summary ? `${warn} — ${summary}` : warn || summary;
    return { decision: 'ask', toolName: 'Bash', input: { command, ...(description ? { description } : {}) } };
  }
  if (name === 'search_web') return { decision: 'ask', toolName: 'WebSearch', input: { query: String(args.query ?? args.Query ?? '') } };
  if (name === 'read_url_content') return { decision: 'ask', toolName: 'WebFetch', input: { url: String(args.Url ?? args.url ?? '') } };
  return { decision: 'ask', toolName: name, input: args };
}

/**
 * An edit: refused when any path it names is Antigravity’s own, and with no card in Auto and Accept edits only when every
 * one stays in the agent’s folders (#1074), else a card about the first that doesn’t.
 */
function decideWrite(name, args, { mode, roots, cwd, scriptPath, home }) {
  const paths = pathArgs(args);
  if (!paths.length || paths.some((p) => isProtectedPath(p, { cwd, scriptPath, home })))
    return { decision: 'deny', reason: 'Postbox doesn’t allow editing Antigravity’s plugin, hook or settings files.' };
  // In Auto, an edit in .git asks: its config and hooks could name a program the routine git commands would run.
  const gitEdit = (/** @type {string} */ p) => mode === 'auto' && readingsOf(p, cwd, home).some((at) => inGit(at) || inGit(realTarget(at, '/')));
  const asks = /** @type {string[]} */ (paths).find((p) => !leadsInto(p, roots, { cwd, home }) || gitEdit(p));
  if (!asks && (mode === 'auto' || mode === 'acceptEdits')) return { decision: 'allow' };
  return { decision: 'ask', toolName: name.startsWith('write') ? 'Write' : 'Edit', input: { file_path: String(asks ?? paths[0]).trim() } };
}

/**
 * A read: with no card when every path it names leads into the agent’s folders, its readable ones or agy’s own (#1074),
 * else a card about the first that doesn’t, naming in paths every one that doesn’t when there are more, so allowing it
 * allows what the card shows (read-folders.mjs’s readPaths).
 */
function decideRead(args, { roots, readFolders, cwd, home }) {
  const paths = pathArgs(args);
  if (!paths.length || paths.some((p) => typeof p !== 'string')) return { decision: 'ask', toolName: 'Read', input: { file_path: '' } };
  const agyDirs = AGY_READABLE.map((d) => realTarget(join(home, '.gemini', 'antigravity-cli', d), '/'));
  // Saved as real paths (read-folders.mjs), so compared as saved, as inReadFolder does: resolved again, one later
  // replaced by a link would lead where the link does (#1074).
  const readable = readFolders.filter((f) => isAbsolute(f));
  const dirs = /** @type {string[]} */ ([...roots, ...readable, ...agyDirs]);
  const outside = /** @type {string[]} */ (paths).filter((p) => !leadsInto(p, dirs, { cwd, home })).map((p) => p.trim());
  if (!outside.length) return { decision: 'allow' };
  return { decision: 'ask', toolName: 'Read', input: { file_path: outside[0], ...(outside.length > 1 ? { paths: outside } : {}) } };
}

function buildOverwrite(check, args, updatedInput, { cwd, scriptPath, home }) {
  if (!updatedInput || typeof updatedInput !== 'object') return null;
  if (check.toolName === 'Bash' && typeof updatedInput.command === 'string' && updatedInput.command !== args?.CommandLine)
    return { ...args, CommandLine: updatedInput.command };
  if ((check.toolName === 'Write' || check.toolName === 'Edit' || check.toolName === 'Read') && typeof updatedInput.file_path === 'string') {
    if (check.toolName !== 'Read' && isProtectedPath(updatedInput.file_path, { cwd, scriptPath, home })) return 'denied';
    if (updatedInput.file_path === check.input.file_path) return null;
    // Back in the field the card was about, of the paths the call names (#1074).
    const named = (/** @type {string} */ k) => typeof args?.[k] === 'string' && args[k].trim() === check.input.file_path;
    const key = PATH_FIELDS.find(named) ?? PATH_FIELDS.find((k) => k in (args ?? {})) ?? 'Path';
    return { ...args, [key]: updatedInput.file_path };
  }
  return null;
}

function resolveHookContext(event, cwd, env) {
  const mode = env.POSTBOX_AGY_MODE || 'ask';
  let folders = [];
  try {
    folders = JSON.parse(env.POSTBOX_AGY_FOLDERS || '[]');
  } catch {
    folders = [];
  }
  if (!Array.isArray(folders) || !folders.length) folders = Array.isArray(event?.workspacePaths) && event.workspacePaths.length ? event.workspacePaths : [cwd];
  let mcpUrl = env.POSTBOX_MCP_URL || '';
  if (!mcpUrl) {
    try {
      const cfg = JSON.parse(readFileSync(join(cwd, '.agents', 'plugins', POSTBOX_SERVER, 'mcp_config.json'), 'utf8'));
      mcpUrl = String(cfg?.mcpServers?.[POSTBOX_SERVER]?.serverUrl ?? '');
    } catch {
      mcpUrl = '';
    }
  }
  return { mode, folders, readFolders: jsonList(env.POSTBOX_AGY_READ), mcpUrl };
}

/** A JSON list of paths from the environment, or none. @param {string | undefined} raw */
function jsonList(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Posts JSON to Postbox’s local /mcp endpoint over node:http instead of global fetch, avoiding undici’s 300-second
 * headersTimeout while waiting up to CARD_WAIT_MS for the person to answer a permission card.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number, requestImpl?: typeof httpRequest }} [opts]
 */
export function mcpPost(url, { method = 'POST', headers = {}, body = '', timeoutMs = HOOK_TIMEOUT_S * 1000, requestImpl = httpRequest } = {}) {
  return new Promise((resolve, reject) => {
    const req = requestImpl(url, { method, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw) });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Permission request timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}

async function evaluateHook(stdinText, { cwd = process.cwd(), env = process.env, scriptPath = HOOK_SCRIPT, home = homedir(), fetchImpl = mcpPost }) {
  let event;
  try {
    event = JSON.parse(String(stdinText ?? ''));
  } catch {
    return { decision: 'deny', reason: 'Postbox’s Antigravity hook received invalid JSON on stdin.' };
  }
  const { mode, folders, readFolders, mcpUrl } = resolveHookContext(event, cwd, env);
  const check = decideAgyTool(event, { mode, folders, readFolders, cwd, scriptPath, home, ...personaOf(env) });
  if (check.decision === 'allow' || check.decision === 'deny') return check;
  if (!mcpUrl) return { decision: 'deny', reason: 'Postbox’s MCP URL is missing, so the hook couldn’t ask for permission.' };
  const requestId = `agy-hook-${randomUUID()}`;
  const res = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: 'permission_prompt', arguments: { tool_name: check.toolName, input: check.input, tool_use_id: requestId } },
    }),
  });
  if (!res?.ok) return { decision: 'deny', reason: `Postbox returned HTTP ${res?.status ?? 'error'} for the permission request.` };
  const rpc = /** @type {any} */ (await res.json());
  if (rpc?.id !== requestId || rpc?.error || rpc?.result?.isError)
    return { decision: 'deny', reason: rpc?.error?.message || rpc?.result?.content?.[0]?.text || 'Postbox refused the permission request.' };
  const decision = JSON.parse(String(rpc?.result?.content?.[0]?.text ?? ''));
  if (decision?.behavior === 'allow') {
    const overwrite = buildOverwrite(check, event?.toolCall?.args ?? {}, decision.updatedInput, { cwd, scriptPath, home });
    if (overwrite === 'denied') return { decision: 'deny', reason: 'Postbox doesn’t allow editing Antigravity’s plugin, hook or settings files.' };
    return overwrite ? { decision: 'allow', overwrite } : { decision: 'allow' };
  }
  if (decision?.behavior === 'deny')
    return {
      decision: 'deny',
      reason: typeof decision.message === 'string' && decision.message.trim() ? decision.message.trim() : 'The person didn’t allow this.',
    };
  return { decision: 'deny', reason: 'Postbox didn’t return an allow decision.' };
}

/**
 * Runs the PreToolUse hook on one stdin payload and writes (if writeOut is given) and returns the JSON decision.
 * Guaranteed by try/finally to emit only { decision: "allow", overwrite? } or { decision: "deny", reason }.
 * @param {string} stdinText
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, scriptPath?: string, home?: string, fetchImpl?: typeof mcpPost, writeOut?: ((s: string) => void)|null }} [opts]
 */
export async function runAgyHook(
  stdinText,
  { cwd = process.cwd(), env = process.env, scriptPath = HOOK_SCRIPT, home = homedir(), fetchImpl = mcpPost, writeOut = null } = {},
) {
  /** @type {{ decision: string, reason?: string, overwrite?: Record<string, any> }} */
  let out = { decision: 'deny', reason: 'Postbox’s Antigravity hook failed before it could check this tool call.' };
  try {
    out = await evaluateHook(stdinText, { cwd, env, scriptPath, home, fetchImpl });
  } catch (e) {
    out = { decision: 'deny', reason: `Postbox’s Antigravity hook hit an error: ${e?.message || 'unknown error'}` };
  } finally {
    if (!out || (out.decision !== 'allow' && out.decision !== 'deny'))
      out = { decision: 'deny', reason: 'Postbox’s Antigravity hook produced an invalid decision.' };
    else if (out.decision === 'deny')
      out = { decision: 'deny', reason: typeof out.reason === 'string' && out.reason.trim() ? out.reason.trim() : 'Postbox didn’t allow this tool call.' };
    else out = out.overwrite && typeof out.overwrite === 'object' ? { decision: 'allow', overwrite: out.overwrite } : { decision: 'allow' };
    writeOut?.(`${JSON.stringify(out)}\n`);
  }
  return out;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    raw = '';
  }
  await runAgyHook(raw, { writeOut: (s) => process.stdout.write(s) });
}
