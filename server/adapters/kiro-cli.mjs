// The Kiro CLI backend (#117): each turn runs the kiro-cli you’re already signed in to, headless with stream-json
// output, and resumes the same Kiro session next turn. Postbox never sees a key or a token: the CLI uses your own
// sign-in (or KIRO_API_KEY, if you set it).
//
//   kiro-cli chat --agent-engine v3 --output-format stream-json --agent <a file Postbox writes for this turn>
//                 --model <persona model, in Kiro’s spelling>  --effort <persona effort>  [--resume-id <session>]
//                 [--trust-all-tools (bypass)]  [--require-mcp-startup (Isolated)]  -- <message>
//
// The chat command has no flag for an MCP server, a system prompt or a deny rule, so all three go in a custom agent
// (kiro.dev/docs/custom-agents/configuration-reference): the guide as its `prompt`, Postbox’s server in its
// `mcpServers`, and the persona’s permissions as `permissions.rules`. The file is written to the agents folder of the
// Kiro home the turn runs with, under a name of its own, and removed when the turn ends: each turn’s file holds its
// session’s MCP URL, so two conversations with the same agent never read each other’s.
//
// The v3 engine, because it is the one that honors `permissions.rules`. Checked with kiro-cli 2.33.1: on v3 a shell
// deny rule held even with --trust-all-tools, and the shell tool wasn’t offered at all; v2 ignored the rule and ran
// the command. v2 also refused Postbox’s own tools in a headless run without `allowedTools`.
//
// What carries over from the Claude Code backend, and what doesn’t (the adapter’s `capabilities`):
// - Resume: --resume-id, which streams only the new turn. A session Kiro no longer has starts over, once.
// - Fork: none. A topic thread’s agent starts fresh, with the message the thread is about (#81).
// - Permissions: a headless run can’t ask, and Kiro treats every ask as a deny (kiro.dev/docs/permissions). So
//   there is no permission card: a refused call shows as a denied step, and the agent says what happened. Claude
//   Code rule syntax (the permissions panel, Allow once, a conversation’s rules) doesn’t reach Kiro.
//   - ask and auto: Kiro’s defaults, plus reads in the agent’s folders. Kiro has no auto classifier.
//   - acceptEdits: also writes in the agent’s folders.
//   - bypass: --trust-all-tools. Deny rules still hold.
// - Tools: the persona’s unticked Tools and the publishing tools become deny rules (kiroRules).
// - Setup (#57): a persona that uses your setup runs with your Kiro home (KIRO_HOME, else ~/.kiro), so your steering,
//   skills, settings, permissions and MCP servers load, as in your terminal. An Isolated persona runs with a Kiro
//   home of Postbox’s own, which holds nothing but the turn’s agent file, and loads only Postbox’s server. Either way
//   a .kiro folder in the agent’s working folder still loads, as a project’s settings do for Claude Code.
// The message goes in as the last argument, after `--`, so one that starts with a dash isn’t read as a flag.
// The CLI runs in its own process group: Stop sends it SIGINT, then SIGKILL if it doesn’t exit, and to every shell it
// started in a group of its own (server/adapters/process-group.mjs, #126). POSTBOX_KIRO_RECORD=<folder> saves each
// turn’s raw stream.
//
// On a remote host (#120, ctx.remote), the turn runs through the host’s daemon: see server/adapters/kiro-cli-remote.mjs.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { checkRemoteContext } from './adapter.mjs';
import { describeTool, isQuietTool } from './claude-stream.mjs';
import { agentFolder } from './folder.mjs';
import { formatMessage, turnGuide } from './guide.mjs';
import { findKiro, kiroModel, postboxModel } from './kiro-cli-models.mjs';
import { attachmentPaths, KIRO_REMOTE, kiroRemoteSpawn } from './kiro-cli-remote.mjs';
import { kiroError, kiroExitError } from './kiro-errors.mjs';
import { listProcesses, stopTurn } from './process-group.mjs';
import { effortOf, modelOf, POSTBOX_SERVER, recorderFor, setupOf } from './setup.mjs';

export { findKiro, kiroModel, kiroModels, kiroVersion, modelIds, postboxModel } from './kiro-cli-models.mjs';
export { kiroRemoteEnv } from './kiro-cli-remote.mjs';
export { kiroExitError as exitError } from './kiro-errors.mjs';

/** What this backend can do, for the runtime and the UI (#117), on a remote host too (KIRO_REMOTE). The adapter adds the models it found. */
export const KIRO_CAPABILITIES = Object.freeze({ resume: true, fork: false, permissions: 'none', tools: 'deny-list', promptTool: false, remote: KIRO_REMOTE });

/**
 * MCP tools that publish outside Postbox, as Kiro’s `server/tool` match patterns, where `*` is any text: the verb
 * rules of PUBLISHING_TOOLS (server/adapters/setup.mjs). Kiro has no claude.ai connectors or built-in publishing
 * tools, so only the verbs carry over. None may match Postbox’s own tools: tests/kiro-cli.test.mjs checks that.
 */
export const KIRO_PUBLISHING = [
  ...['send', 'post', 'reply', 'publish', 'share', 'comment'].flatMap((v) => [`*/${v}`, `*/${v}_*`]),
  ...['send', 'publish'].map((v) => `*/*_${v}_*`),
];

/**
 * The persona’s Tools checklist as Kiro capabilities (kiro.dev/docs/permissions): an id that isn’t ticked denies
 * them. agents.outside has nothing to deny here: Kiro’s subagent tool runs inside the turn, as Claude Code’s Task
 * does, and the chat command has no tool that messages or schedules other sessions.
 */
export const KIRO_TOOL_RULES = /** @type {Record<string, string[]>} */ ({ shell: ['shell'], 'web.fetch': ['web_fetch', 'web_search'] });

/** A folder as given and as resolved: Kiro matches resolved paths (/tmp is /private/tmp on macOS). */
const spellings = (dir) => {
  try {
    const real = realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
};

/**
 * The agent’s permission rules. Their order doesn’t matter: in Kiro, deny beats ask beats allow, whatever the scope
 * a rule comes from (kiro.dev/docs/permissions), so a deny here holds against an allow in your own rules.
 * @param {{ persona: any, folders: string[], resolve?: boolean }} turn  folders: where the agent works, and the folders
 *   it may also use; resolve: also name each as resolved here (false for a host’s folders, which aren’t on this disk)
 */
export function kiroRules({ persona, folders, resolve = true }) {
  const { canPublish, usesHostSetup, mcpOff } = setupOf(persona);
  const has = new Set(Array.isArray(persona?.tools) ? persona.tools : []);
  const dirs = [...new Set(folders.filter(Boolean).flatMap(resolve ? spellings : (d) => [d]))];
  const rules = [
    // Postbox’s own tools never need asking: they only show things in the thread.
    { capability: 'mcp', match: [`${POSTBOX_SERVER}/*`], effect: 'allow' },
  ];
  if (dirs.length) rules.push({ capability: 'fs_read', match: dirs, effect: 'allow' });
  if (persona?.permissionMode === 'acceptEdits' && dirs.length) rules.push({ capability: 'fs_write', match: dirs, effect: 'allow' });
  for (const [id, caps] of Object.entries(KIRO_TOOL_RULES))
    if (!has.has(id)) for (const capability of caps) rules.push({ capability, match: ['*'], effect: 'deny' });
  if (!canPublish) rules.push({ capability: 'mcp', match: KIRO_PUBLISHING, effect: 'deny' });
  // Servers the persona turned off: their tools are denied.
  if (usesHostSetup && mcpOff.length) rules.push({ capability: 'mcp', match: mcpOff.map((n) => `${n}/*`), effect: 'deny' });
  // Isolated: every server but Postbox’s is denied. An empty Kiro home and includeMcpJson: false aren’t enough on
  // their own: a managed install can add its own server, and an allow rule for it, to every agent file when the
  // CLI starts (seen with a toolbox-installed kiro-cli 2.33.1), and the deny beats that allow. Checked live: a second
  // server’s call was refused by this rule while Postbox’s went through (tests/fixtures/kiro-cli/isolated-deny.jsonl).
  // Kiro still lists the denied server’s tools to the model; it refuses the call.
  if (!usesHostSetup) rules.push({ capability: 'mcp', match: ['*/*'], exclude: [`${POSTBOX_SERVER}/*`], effect: 'deny' });
  return rules;
}

// A live turn (kiro-cli 2.33.1) had a command refused as “The user rejected this tool call.”, and the agent told the
// person they had declined it. Nobody was asked, so the agent is told what a refusal means here.
const HEADLESS_NOTE =
  '## Refused tool calls\n\nPostbox runs you headless, so Kiro can’t ask the person to approve a tool call: one that would need approval is refused, and Kiro reports it as “The user rejected this tool call.” The person didn’t see or decline it. Say which call was refused and that the agent’s permissions in Postbox didn’t allow it, then carry on without it.';

// Kiro still lists a denied server’s tools to the model; it only refuses the call. In the mixed-room UAT, an Isolated
// agent offered “Manage scoped AWS credentials” from a server a managed install had added, so it’s told.
const ISOLATED_NOTE =
  '## Tools you can use\n\nOnly Postbox’s MCP server is allowed for you here. Tools from any other MCP server you see listed are refused, so don’t offer or use them, and don’t count them among what you can do.';

/**
 * The custom agent for one turn. Pure, so the tests can check it.
 * @param {{ name: string, persona: any, mcpUrl?: string, shim?: { command: string, args: string[] }, guide: string, folders: string[] }} turn
 *   shim: on a remote host, Postbox’s server is the host’s stdio shim, run as this command, in place of mcpUrl; the
 *   folders are then the host’s
 */
export function kiroAgent({ name, persona, mcpUrl = '', shim, guide, folders }) {
  const { usesHostSetup } = setupOf(persona);
  return {
    name,
    description: `@${persona.handle} in Postbox`,
    prompt: `${guide}\n\n${HEADLESS_NOTE}${usesHostSetup ? '' : `\n\n${ISOLATED_NOTE}`}`,
    tools: ['*'],
    // Your global and workspace mcp.json, unless the persona is Isolated.
    includeMcpJson: usesHostSetup,
    // A local server is a command and its arguments (kiro.dev/docs/custom-agents/configuration-reference).
    mcpServers: { [POSTBOX_SERVER]: shim ? { command: shim.command, args: [...shim.args] } : { type: 'http', url: mcpUrl } },
    permissions: { rules: kiroRules({ persona, folders, resolve: !shim }) },
  };
}

/**
 * The CLI arguments for one turn. Pure, so the tests can check them.
 * @param {{ persona: any, agent: string, sessionId?: string|null, prompt: string, stdin?: boolean }} turn
 */
export function kiroArgs({ persona, agent, sessionId = null, prompt, stdin = false }) {
  const { usesHostSetup } = setupOf(persona);
  return [
    'chat',
    '--agent-engine',
    'v3',
    '--output-format',
    'stream-json',
    '--agent',
    agent,
    // Both always passed: left out, Kiro’s own settings would decide (#60).
    '--model',
    kiroModel(modelOf(persona)),
    '--effort',
    effortOf(persona),
    ...(sessionId ? ['--resume-id', sessionId] : []),
    ...(persona?.permissionMode === 'bypass' ? ['--trust-all-tools'] : []),
    // Isolated loads Postbox’s server only, so a turn without it fails rather than runs blind. Your own servers
    // aren’t held to that: one that doesn’t start shouldn’t stop every turn.
    ...(usesHostSetup ? [] : ['--require-mcp-startup']),
    ...(stdin ? ['--no-interactive'] : ['--', prompt]),
  ];
}

/** The Kiro home a persona runs with: yours (KIRO_HOME, else ~/.kiro), or Postbox’s own when Isolated. */
export const kiroHomeFor = (persona, { isolatedHome, env = process.env, home = homedir() }) =>
  setupOf(persona).usesHostSetup ? env.KIRO_HOME || join(home, '.kiro') : isolatedHome;

const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const firstSentence = (s, n = 300) => clip(/^[\s\S]*?[.!?](?=\s|$)/.exec(String(s ?? '').trim())?.[0] ?? s, n);
const contentText = (content) =>
  (Array.isArray(content) ? content : [])
    .map((c) => (c?.type === 'content' ? c.content : c))
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join(' ');
// How v3 refuses a call it would ask about (recorded): a pending_interaction (tool_approval) for the call, then
// lint-allow spelling: “cancelled” is Kiro’s value, as it sends it.
// interaction_resolved with outcome “cancelled”, then the call fails with “The user rejected this tool call.” The
// turn itself still succeeds, so the stream is the only record. The text is the fallback, and v2’s wording. The
// UAT’s checks read recorded streams with it too (tools/uat/checks.mjs).
export const REFUSED = /The user rejected this tool call|permission approval is not supported/;
// Labels for Kiro’s tool kinds (ACP’s ToolKind), until a title arrives.
const KINDS = {
  read: 'Reading a file',
  edit: 'Editing a file',
  delete: 'Deleting a file',
  move: 'Moving a file',
  search: 'Searching files',
  execute: 'Running a command',
  fetch: 'Fetching a page',
  think: 'Thinking',
};

/**
 * The tool a call stands for, in Claude Code’s naming where Postbox has words for it: an MCP tool is
 * mcp__<server>__<tool>, so Postbox’s own tools get the same labels and stay quiet. v3 names an MCP call in its
 * input (tool_id “postbox::show_block”) and _meta.kiro.serverName; v2 in _meta.kiro.toolName and mcpServerName.
 */
export function toolOf(u) {
  const kiro = u?._meta?.kiro ?? {};
  const id = typeof u?.rawInput?.tool_id === 'string' ? /^([^:]+)::(.+)$/.exec(u.rawInput.tool_id) : null;
  const server = id?.[1] ?? kiro.serverName ?? kiro.mcpServerName ?? null;
  const tool = id?.[2] ?? kiro.toolName ?? null;
  if (server && tool) return { name: `mcp__${server}__${tool}`, input: id ? (u.rawInput.arguments ?? {}) : (u.rawInput ?? {}) };
  return { name: null, input: u?.rawInput ?? {} };
}

/**
 * Turns kiro-cli’s stream-json output into Postbox’s turn context. Every line is { type, data }: runStarted, then
 * sessionUpdate (an ACP session/update: agentclientprotocol.com/protocol/prompt-turn), then runFinished or runError.
 * v3 also sends session_info_update (_meta.kiro: context use, turn start and end), available_commands_update and
 * config_option_update (the session’s model, among others); v2 sends metadata with the context use. Pure apart from
 * the ctx calls, so recorded streams can test it.
 * @param {any} ctx @param {{ now?: () => number, effort?: string|null }} [opts]
 */
export function createKiroMapper(ctx, { now = Date.now, effort = null } = {}) {
  const st = {
    sessionId: /** @type {string|null} */ (null),
    model: /** @type {string|null} */ (null),
    finished: /** @type {any} */ (null),
    error: /** @type {string|null} */ (null),
    missingSession: false,
    asked: new Map(), // toolCallId → what Kiro would have asked (“Write File”, “echo hi”)
    refused: new Set(), // toolCallIds whose ask no one could answer
    steering: /** @type {string[]} */ ([]), // steering files Kiro loaded (steering_inclusion)
    wrote: false,
    afterTool: false,
    thought: '',
    thoughts: 0,
    tools: new Map(),
    state: /** @type {string|null} */ (null),
    ctx: /** @type {number|null} */ (null),
  };
  const status = (patch) => {
    if (patch.state && patch.state === st.state && Object.keys(patch).length === 1) return;
    if (patch.state) st.state = patch.state;
    ctx.status(patch);
  };
  // Kiro reports context use after nearly every event; the ring shows whole percents, so only a change is passed on.
  const contextUsed = (pct) => {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return;
    const n = Math.min(100, Math.round(pct));
    if (n === st.ctx) return;
    st.ctx = n;
    status({ ctx: n });
  };
  const flushThought = () => {
    const t = st.thought.trim();
    st.thought = '';
    if (!t) return;
    st.thoughts += 1;
    ctx.activity({ id: `thought-${st.thoughts}`, label: firstSentence(t, 120), state: 'done', kind: 'thought', detail: clip(t, 1200) });
  };
  const startTool = (u) => {
    const { name, input } = toolOf(u);
    // v3 loads tool definitions on demand (“Tool Load”), as Claude Code’s ToolSearch does.
    const quiet = name ? isQuietTool(name) : u.title === 'Tool Load';
    const label = name ? describeTool(name, input) : clip(u.title || KINDS[u.kind] || 'Using a tool', 80);
    const t = { label, quiet, started: now(), done: false };
    st.tools.set(u.toolCallId, t);
    if (!quiet) ctx.activity({ id: u.toolCallId, label, state: 'running' });
    status({ state: 'tool', currentStep: label });
    st.afterTool = true;
    return t;
  };
  const endTool = (u) => {
    const t = st.tools.get(u.toolCallId) ?? startTool(u);
    if (t.done) return;
    t.done = true;
    const failed = u.status === 'failed';
    const why = failed ? (contentText(u.content) || String(u.rawOutput?.message ?? '')).replace(/^Output:\s*/, '') : '';
    // Refused for want of an answer (an ask no one could take), or by a deny rule, which v3 reports as
    // _meta.kiro.policyDenial (recorded: “Tool call denied by user's permissions. Rule: deny mcp matching …”).
    const unanswered = failed && (st.refused.has(u.toolCallId) || REFUSED.test(why));
    const refused = unanswered || (failed && Boolean(u._meta?.kiro?.policyDenial));
    const state = refused ? 'denied' : failed ? 'failed' : 'done';
    // Kiro words a refusal as the person’s answer, but nobody was asked: say what happened instead.
    const asked = st.asked.get(u.toolCallId);
    const detail = unanswered
      ? `Kiro asks before this${asked ? ` (“${clip(asked, 80)}”)` : ''}, and can’t ask you from Postbox, so it was refused.`
      : refused
        ? 'Its permissions in Postbox don’t allow this.'
        : failed && why
          ? firstSentence(why, 300)
          : '';
    if (!t.quiet) ctx.activity({ id: u.toolCallId, label: t.label, state, ms: now() - t.started, ...(detail ? { detail } : {}) });
  };

  const update = (u) => {
    const kind = u?.sessionUpdate;
    if (kind !== 'agent_thought_chunk') flushThought();
    switch (kind) {
      case 'agent_message_chunk': {
        const text = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (!text) return;
        // Text after a tool call is a new paragraph: Kiro runs the two together (its finalText does).
        if (st.wrote && st.afterTool) ctx.text('\n\n');
        st.afterTool = false;
        st.wrote = true;
        // Text arrives a few characters at a time: the ring changes once, not with every chunk.
        if (st.state !== 'gen') status({ state: 'gen', currentStep: 'Writing a reply' });
        ctx.text(text);
        return;
      }
      case 'agent_thought_chunk':
        st.thought += u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (st.state !== 'think') status({ state: 'think', currentStep: 'Thinking' });
        return;
      case 'tool_call':
        if (!st.tools.has(u.toolCallId)) startTool(u);
        if (u.status === 'completed' || u.status === 'failed') endTool(u);
        return;
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') endTool(u);
        else if (!st.tools.has(u.toolCallId)) startTool(u);
        return;
      case 'session_info_update': {
        const k = u._meta?.kiro;
        if (k?.kind === 'context_usage') contextUsed(k.usagePercentage);
        else if (k?.kind === 'turn_start') status({ state: 'think', currentStep: 'Thinking' });
        else if (k?.kind === 'pending_interaction' && k.interactionType === 'tool_approval' && k.toolCallId)
          st.asked.set(k.toolCallId, String(k.question ?? ''));
        // lint-allow spelling: Kiro’s value.
        else if (k?.kind === 'interaction_resolved' && k.outcome === 'cancelled' && st.asked.has(k.toolCallId)) st.refused.add(k.toolCallId);
        else if (k?.kind === 'steering_inclusion' && Array.isArray(k.steeringDocuments)) st.steering = k.steeringDocuments.map(String);
        return;
      }
      case 'config_option_update': {
        const opt = (Array.isArray(u.configOptions) ? u.configOptions : []).find((o) => o?.id === 'model');
        const model = postboxModel(opt?.currentValue);
        if (model && model !== st.model) {
          st.model = model;
          ctx.reported?.({ model, ...(effort ? { effort } : {}) });
        }
        return;
      }
      default:
    }
  };

  return {
    get sessionId() {
      return st.sessionId;
    },
    get model() {
      return st.model;
    },
    get finished() {
      return st.finished;
    },
    get error() {
      return st.error;
    },
    get missingSession() {
      return st.missingSession;
    },
    /** The steering files the turn loaded: none for an Isolated persona (#57). */
    get steering() {
      return st.steering;
    },
    push(e) {
      const d = e?.data ?? {};
      if (typeof d.sessionId === 'string' && d.sessionId && !st.sessionId) st.sessionId = d.sessionId;
      switch (e?.type) {
        case 'runStarted':
          status({ state: 'think', currentStep: 'Thinking' });
          return;
        case 'sessionUpdate':
          update(d.update);
          return;
        case 'metadata':
          contextUsed(d.contextUsagePercentage);
          return;
        case 'runFinished':
          flushThought();
          st.finished = d;
          if (d.status !== 'success')
            st.error = `Kiro ended the turn with ${clip(d.status ?? 'no status', 40)}${d.stopReason ? ` (${clip(d.stopReason, 40)})` : ''}.`;
          else if (d.stopReason === 'refusal') st.error = 'The model refused to continue this turn.';
          else if (d.stopReason === 'max_tokens') st.error = 'The reply hit the model’s output limit before it finished.';
          return;
        case 'runError':
          flushThought();
          st.error = `Kiro couldn’t run the turn: ${clip(d.message ?? 'no reason given', 400)}`;
          // A session to resume that Kiro no longer has (recorded: stage init, “Session '<id>' not found”).
          if (/^Session '.*' not found/.test(String(d.message ?? ''))) st.missingSession = true;
          return;
        default:
      }
    },
  };
}

export class KiroCliAdapter {
  name = 'kiro-cli';

  /**
   * @param {{ bin?: string, workRoot: string, isolatedHome: string, models?: string[], spawnImpl?: typeof spawn, env?: NodeJS.ProcessEnv,
   *           kill?: import('./process-group.mjs').KillFn, listProcesses?: () => Promise<import('./process-group.mjs').Proc[]> }} opts
   *   models: what kiroModels found, offered in the model field; kill and listProcesses: how Stop signals and finds
   *   processes, which tests fake
   */
  constructor({
    bin = findKiro(),
    workRoot,
    isolatedHome,
    models = [],
    spawnImpl = spawn,
    env = process.env,
    kill = process.kill,
    listProcesses: list = listProcesses,
  }) {
    this.kill = kill;
    this.list = list;
    this.capabilities = { ...KIRO_CAPABILITIES, ...(models.length ? { models } : {}) };
    this.bin = bin;
    this.workRoot = workRoot;
    this.isolatedHome = isolatedHome;
    this.spawn = spawnImpl;
    this.env = env;
  }

  /** The folder the agent works in, by the rule every backend shares (folder.mjs). */
  folderFor(persona, project) {
    return agentFolder(persona, project, this.workRoot);
  }

  async deliver(session, message, ctx) {
    const persona = ctx.persona;
    // On a host, its folder there, and the host turn’s copies of attachments; laptop folders don’t cross (the header).
    const cwd = ctx.remote ? ctx.remote.folder : await this.folderFor(persona, ctx.project);
    const { guide, message: turnMessage } = turnGuide(message, { ...ctx, persona, session, brief: session?.brief, toolRules: KIRO_TOOL_RULES });
    const promptOn = (turn = ctx.remote?.turn) => formatMessage(turnMessage, attachmentPaths(ctx, turn));
    const folders = ctx.remote ? [cwd] : [...new Set([cwd, ctx.project?.folder, ...(ctx.addDirs ?? [])])].filter(Boolean);
    // Before anything starts on the host: the turn ID and version the runtime owns. After a Postbox restart,
    // ctx.remote.attach names a turn already there instead, which is replayed from the start and never started again.
    const attach = ctx.remote?.attach?.turn ?? null;
    if (ctx.remote) checkRemoteContext(ctx.remote, { attach: Boolean(attach) });
    if (attach) {
      await this.run({ ctx, cwd, folders, prompt: promptOn(attach), guide, sessionId: ctx.state.kiroSessionId ?? null, turn: attach, attach: true });
      return;
    }
    const first = await this.run({ ctx, cwd, folders, prompt: promptOn(), guide, sessionId: ctx.state.kiroSessionId ?? null, turn: ctx.remote?.turn });
    // A session Kiro no longer has (its history was cleared, or the persona moved between your setup and
    // Isolated, which keep sessions in different homes) starts over, once.
    if (first.missingSession) {
      ctx.saveState({ kiroSessionId: null });
      const note = '[Postbox] Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n';
      // On a host, a second host turn, which the runtime persists before nextTurn returns.
      const turn = ctx.remote ? await ctx.remote.nextTurn() : undefined;
      await this.run({ ctx, cwd, folders, prompt: note + promptOn(turn), guide, sessionId: null, turn });
    }
  }

  /**
   * @param {{ ctx: any, cwd: string, folders: string[], prompt: string, guide: string, sessionId: string|null, turn?: string, attach?: boolean }} o
   *   turn: on a remote host, the host turn this run starts as (the runtime’s); attach: it’s already there
   */
  async run({ ctx, cwd, folders, prompt, guide, sessionId, turn, attach = false }) {
    const persona = ctx.persona;
    const agent = `postbox-${String(persona.handle).replace(/[^a-z0-9_-]/gi, '')}-${randomUUID().slice(0, 8)}`;
    const args = kiroArgs({ persona, agent, sessionId, prompt, stdin: Boolean(ctx.remote) });
    /** @type {string | null} the agent file on this computer, removed when the turn ends */
    let file = null;
    let spawnFn = this.spawn;
    let env;
    if (ctx.remote) {
      const agentText = (shim) => JSON.stringify(kiroAgent({ name: agent, persona, shim, guide, folders }), null, 2);
      spawnFn = /** @type {any} */ (kiroRemoteSpawn(ctx, { agent, cwd, turn, attach, agentText }));
      env = {};
    } else {
      const home = kiroHomeFor(persona, { isolatedHome: this.isolatedHome, env: this.env });
      file = join(home, 'agents', `${agent}.json`);
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(file, JSON.stringify(kiroAgent({ name: agent, persona, mcpUrl: ctx.mcpUrl, guide, folders }), null, 2));
      env = { ...this.env, ...(setupOf(persona).usesHostSetup ? {} : { KIRO_HOME: home }) };
    }
    const mapper = createKiroMapper(ctx, { effort: effortOf(persona) });
    try {
      return await new Promise((resolve, reject) => {
        let child;
        try {
          // Its own process group, so Stop reaches everything it started (#126).
          child = spawnFn(this.bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        } catch (e) {
          reject(new Error(`Couldn’t start the Kiro CLI (${this.bin}): ${e.message}`));
          return;
        }
        if (ctx.remote && !attach) child.stdin.end(prompt);
        let stderr = '';
        const c = child;
        const exited = new Promise((r) => {
          c.once('exit', r);
          c.once('close', r);
          c.once('error', r);
        });
        /** @type {Promise<{ gone: Promise<void> }>|null} */
        let stopping = null;
        const onAbort = () => {
          stopping = stopTurn(c, { exited, kill: this.kill, list: this.list });
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', (e) =>
          reject(
            kiroError(
              e.code === 'ENOENT'
                ? 'The Kiro CLI isn’t installed, or isn’t on the PATH. Install it, or set POSTBOX_KIRO_BIN.'
                : `The Kiro CLI couldn’t start: ${e.message}`,
              e,
            ),
          ),
        );
        child.stderr.on('data', (d) => {
          stderr = (stderr + d).slice(-4000);
        });
        const record = recorderFor(ctx, this.env.POSTBOX_KIRO_RECORD, 'kiro-cli');
        createInterface({ input: child.stdout }).on('line', (line) => {
          if (!line.trim()) return;
          record(line);
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            return; // not every line has to be JSON
          }
          try {
            mapper.push(e);
          } catch (err) {
            console.error(`Postbox couldn’t read a Kiro CLI event: ${err.message}`);
          }
          // Saved as soon as it’s known, so a turn you stop still resumes next time.
          if (mapper.sessionId && mapper.sessionId !== ctx.state.kiroSessionId && !mapper.missingSession) {
            ctx.state.kiroSessionId = mapper.sessionId;
            ctx.saveState({ kiroSessionId: mapper.sessionId });
          }
        });
        let finished = false;
        const done = (code) => {
          if (finished) return;
          finished = true;
          ctx.signal.removeEventListener('abort', onAbort);
          if (mapper.model) ctx.saveState({ model: mapper.model });
          if (ctx.signal.aborted) return resolve({});
          if (sessionId && mapper.missingSession) return resolve({ missingSession: true });
          if (mapper.error) return reject(kiroError(mapper.error, mapper.error));
          if (code !== 0 || !mapper.finished) {
            const message = kiroExitError(code, stderr);
            return reject(kiroError(message, `${message} ${stderr}`));
          }
          resolve({});
        };
        // A stopped turn ends once the CLI’s whole group has exited, as for the Claude backends (#126).
        const settle = (code) => {
          if (ctx.signal.aborted && stopping) stopping.then((r) => r.gone).then(() => done(code));
          else done(code);
        };
        child.on('close', settle);
        child.on('exit', (code) => {
          if (ctx.signal.aborted) settle(code);
        });
      });
    } finally {
      // A remote turn’s file is the daemon’s to remove.
      if (file) await rm(file, { force: true }).catch(() => {});
    }
  }
}
