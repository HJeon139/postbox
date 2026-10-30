// The Antigravity CLI backend (#143): each turn runs the agy you’re already signed in to, headless with stream-json
// output, and resumes the same conversation next turn. It brings Gemini models into Postbox. Postbox never sees a
// key or a token: the CLI uses your own sign-in (or GEMINI_API_KEY, if your settings say so).
//
//   agy --model <model> [--effort <effort>] [--conversation <id>] [--mode auto|accept-edits]
//       [--dangerously-skip-permissions] --disable-slash-commands --output-format stream-json [--add-dir <dir>]…
//       --print=<message>
//
// agy has no flag for an MCP server, a system prompt or a rule, and no setting for where its config lives
// (antigravity.google/docs/cli/reference). So each turn writes a workspace plugin into the agent’s folder:
//
//   <folder>/.agents/plugins/postbox/plugin.json        { "name": "postbox" }
//   <folder>/.agents/plugins/postbox/mcp_config.json    Postbox’s server, with this conversation’s MCP URL
//   <folder>/.agents/plugins/postbox/rules/AGENTS.md    the guide, and what Postbox can’t enforce here
//
// and removes it when the turn ends. Checked with agy 1.4.5: the plugin’s server loads as `postbox_postbox` (plugin,
// then server), and the plugin’s rules reach the model. Two turns in one folder would overwrite each other’s
// plugin, so a turn waits for the one before it in the same folder (FolderQueue). In a git repo the plugin folder
// goes in .git/info/exclude, so it never shows in git status.
//
// Headless, agy refuses every call it would ask about, Postbox’s own tools included (recorded: “user denied
// permission for mcp(postbox_postbox/show_block)”). So the first turn adds one allow rule, mcp(postbox_postbox/*),
// to your agy settings (~/.gemini/antigravity-cli/settings.json). Only Postbox’s plugin names that server, and it
// exists only while a turn runs.
//
// What carries over from the Claude Code backend, and what doesn’t (the adapter’s `capabilities`):
// - Resume: --conversation, which streams only the new turn. agy doesn’t fail on a conversation it no longer has:
//   it warns and starts a new one. Postbox sees the new id in `init`, stops that run, and starts over once, saying so.
// - Fork: none. A topic thread’s agent starts fresh, with the message the thread is about (#81).
// - Permissions (#370): a headless run can’t ask. With agy 1.4.7 or newer, ask, auto and acceptEdits run with
//   --dangerously-skip-permissions once Postbox’s PreToolUse hook is confirmed (agy-hook.mjs), and the hook decides
//   each call, asking you through a permission card. In auto it approves routine calls itself (agy-auto.mjs), since
//   agy’s own auto mode isn’t offered to every account (“--mode auto is not available for this account”, which
//   this computer’s agy logged on every run from 1.4.5 to 1.4.7), and a hook’s allow only hands a call on to agy’s
//   policy (antigravity.google/docs/hooks). Without the hook, a refused call shows as a denied step:
//   - ask: agy’s default; edits and commands outside its allow rules are refused.
//   - auto: --mode auto, agy’s own sandbox and safety check. What it would still ask about is refused. An account
//     without auto mode runs as ask: agy warns and continues in its default mode.
//   - acceptEdits: --mode accept-edits.
//   - bypass: --dangerously-skip-permissions, always, with no hook.
// - Tools: agy reads deny rules only from your own settings, which every agy session shares, so a persona’s
//   unticked Tools can’t be turned off for one turn (tools: 'none'). The rules file tells the agent not to use them.
// - Setup (#57): always yours (isolation: false). agy reads its config from ~/.gemini and has no setting to move it;
//   with another HOME it isn’t signed in. Your rules, skills, plugins and MCP servers load, as in your terminal.
// - Effort: agy names it in some model ids (gemini-3.8-flash-high), takes --effort for others (gemini-3.8-flash:
//   low, medium, high), and refuses it for the rest (claude-sonnet-4-6). See agyEffort.
// Stop sends SIGINT, then SIGKILL if the CLI doesn’t exit. POSTBOX_AGY_RECORD=<folder> saves each turn’s raw stream.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { AGY_DEFAULT_MODEL } from '../../shared/agent-facts.mjs';
import { TOOL_DEFS } from '../../shared/mcp-tools.mjs';
import { agyHookCommand, agyHooksJson, agySupportsHooks, confirmAgyHook, HOOK_SCRIPT, HOOK_TIMEOUT_S } from './agy-hook.mjs';
import { clip, HEADLESS_NOTE, HOOK_NOTE, LOOKING_NOTE, refusalFollowUp, refusalOf } from './agy-refusals.mjs';
import { AGY_SERVER, ALLOW_POSTBOX, agySettingsFile, allowPostbox } from './agy-settings.mjs';
import { toolOf } from './agy-tools.mjs';
import { describeTool } from './claude-stream.mjs';
import { agyContextPercent, agyWindowFor } from './context-usage.mjs';
import { agentFolder } from './folder.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { listProcesses, stopTurn } from './process-group.mjs';
import { DEFAULT_MODEL, EFFORT_LEVELS, effortOf, modelOf, POSTBOX_SERVER, recorderFor, setupOf, TOOL_WORDS, toolsOff } from './setup.mjs';
import { agyResult } from './work-calls.mjs';

/** What this backend can do, for the runtime and the UI (#117, #370). The adapter adds the models it found. */
export const AGY_CAPABILITIES = Object.freeze({ resume: true, fork: false, permissions: 'none', tools: 'none', isolation: false, promptTool: true });

/** The agy binary: POSTBOX_AGY_BIN, then the PATH. */
export const findAgy = (env = process.env) => env.POSTBOX_AGY_BIN || 'agy';

/** The installed version (“1.4.5”), or null if the CLI can’t be run. */
export function agyVersion(bin = findAgy()) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let p;
    try {
      p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null); // a path that can’t be a binary (ENOTDIR) throws rather than emitting an error
    }
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split(/\s+/).at(-1) || 'unknown' : null);
    });
  });
}

/**
 * The models this sign-in offers, for the model field’s suggestions: Gemini’s, and the others agy runs (Claude,
 * GPT-OSS). Read from `agy models`, which runs no model. Empty if it fails.
 * @returns {Promise<string[]>}
 */
export function agyModels(bin = findAgy()) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let p;
    try {
      p = spawn(bin, ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve([]);
    }
    const timer = setTimeout(() => p.kill(), 15000);
    p.stdout.on('data', (d) => {
      out = (out + d).slice(-200_000);
    });
    p.on('error', () => resolve([]));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? modelIds(out) : []);
    });
  });
}

/**
 * The model ids in an `agy models` answer, bounded: one per line, the id, then a tab and its name
 * (“gemini-3.8-flash-high	Gemini 3.8 Flash (High)”). The “Fetching available models...” line and a sign-in
 * error aren’t ids.
 */
export function modelIds(text) {
  const ids = String(text ?? '')
    .split('\n')
    .map((l) => /^([a-z0-9][\w.:-]{0,79})\t/i.exec(l)?.[1])
    .filter((id) => typeof id === 'string');
  return [...new Set(ids)].slice(0, 60);
}

export { AGY_DEFAULT_MODEL };

/**
 * The model to pass. A persona that names none gets Postbox’s default, Claude’s, which agy doesn’t offer: that
 * becomes Gemini’s. A model the persona named is passed as it is, and agy says if it doesn’t know it.
 * @param {any} persona @param {string[]} [offered]  what agyModels found
 */
export function agyModel(persona, offered = []) {
  const model = modelOf(persona);
  if (model !== DEFAULT_MODEL || offered.includes(model)) return model;
  return offered.includes(AGY_DEFAULT_MODEL) || !offered.length ? AGY_DEFAULT_MODEL : offered[0];
}

/** The effort levels agy takes with a base Gemini model (recorded: “gemini-3.8-flash has no "xhigh" effort”). */
export const AGY_EFFORTS = ['low', 'medium', 'high'];

/**
 * The --effort to pass, or null for none. Checked with agy 1.4.5:
 * - An id that names its effort runs at it, and refuses a different one (“--model gemini-3.8-flash-high conflicts
 *   with --effort=max”), so none is passed.
 * - A base Gemini model (gemini-3.8-flash) takes low, medium or high; above high runs at high.
 * - Other models refuse the flag (“--effort is not supported for model "claude-sonnet-4-6"”).
 */
export function agyEffort(model, effort) {
  if (named(model) || !/^gemini-/.test(String(model))) return null;
  const level = EFFORT_LEVELS.includes(effort) ? effort : 'medium';
  return AGY_EFFORTS.includes(level) ? level : 'high';
}
/** The effort a model id names (“gemini-3.8-flash-low” → low), or null. */
const named = (model) => /-(low|medium|high)$/.exec(String(model))?.[1] ?? null;
/** The effort a turn ran at, for the model chip: the one passed, or the one the id names. */
export const effortRun = (model, passed) => passed ?? named(model);

export { AGY_SERVER, ALLOW_POSTBOX, agyContextPercent, agySettingsFile, agyWindowFor, allowPostbox };

/** The persona’s permission mode as agy’s flags (#370: --dangerously-skip-permissions only once the PreToolUse hook is confirmed). */
export function modeArgs(persona, { hookConfirmed = false } = {}) {
  if (hookConfirmed) return ['--dangerously-skip-permissions'];
  switch (persona?.permissionMode) {
    case 'auto':
      return ['--mode', 'auto'];
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'bypass':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/**
 * The CLI arguments for one turn. Pure, so the tests can check them. Every flag comes before the message: given
 * as --print=<message>, it is one argument whatever it starts with.
 * @param {{ persona: any, model: string, effort: string|null, sessionId?: string|null, prompt: string, addDirs?: string[], hookConfirmed?: boolean }} turn
 */
export function agyArgs({ persona, model, effort, sessionId = null, prompt, addDirs = [], hookConfirmed = false }) {
  return [
    // Both always passed, where agy takes them: left out, your agy settings would decide (#60).
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    ...(sessionId ? ['--conversation', sessionId] : []),
    ...modeArgs(persona, { hookConfirmed }),
    // A message that starts with / is the person’s text, not one of agy’s commands.
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    `--print=${prompt}`,
  ];
}

/**
 * Where agy keeps each Postbox tool’s input schema, which the model reads before a call (recorded: read_file of
 * <dir>/show_block.json). In the Gemini room UAT, an agent that wasn’t told ran `ls` on the folder to find the
 * tools, which was refused and ended its turn with no reply. So it’s told the names and the paths.
 * @param {string} dir  agy’s schema folder for Postbox’s server
 */
export const toolsNote = (dir) =>
  `## Postbox’s tools in Antigravity\n\nAntigravity names Postbox’s MCP server ${AGY_SERVER}. Its tools: ${TOOL_DEFS.map((t) => t.name).join(', ')}. Before you first call one, read its input schema with read_file at ${join(dir, '<tool>.json')}, such as ${join(dir, 'show_block.json')}. Don’t run a command to list them.`;

/**
 * The plugin’s rules file: the guide, the note on refusals, and what the persona turned off that agy can’t (in
 * TOOL_WORDS, the words the agent can act on).
 * Pure, so the tests can check it.
 * What it says about approval follows how agy runs: with the PreToolUse hook, calls ask through a card (HOOK_NOTE); in Run
 * everything, nothing is asked; without the hook (agy before 1.4.7), headless agy refuses them (HEADLESS_NOTE).
 * @param {{ persona: any, guide: string, schemas?: string|null, hooked?: boolean }} turn  schemas: agy’s schema folder for
 *   Postbox’s server; hooked: the PreToolUse hook runs this turn
 */
export function agyRules({ persona, guide, schemas = null, hooked = false }) {
  const ids = toolsOff(persona, TOOL_WORDS);
  const off = ids.map((id) => `${TOOL_WORDS[id]} (${id})`);
  const { canPublish } = setupOf(persona);
  if (!canPublish) off.push('publishing or posting anything outside Postbox');
  // A tool id can be turned on from a card the agent asks for (#104); publishing is the persona’s own setting.
  const ask = ids.length
    ? ` If a task needs ${ids.length === 1 ? 'it' : 'one of the tools'}, say it’s turned off in Postbox, and ask the person to turn it on with ask_for_tool { tool: "${ids[0]}", why }.`
    : '';
  const limits = off.length
    ? `## What you don’t do here\n\nThe person turned these off for you in Postbox: ${off.join('; ')}. Antigravity can’t enforce that, so it’s up to you: don’t do them, and say so if a task needs one.${ask}`
    : '';
  const bypass = persona?.permissionMode === 'bypass';
  const approval = bypass ? '' : hooked ? HOOK_NOTE : `${HEADLESS_NOTE}\n\n${LOOKING_NOTE}`;
  return `${[guide, schemas ? toolsNote(schemas) : '', approval, limits].filter(Boolean).join('\n\n')}\n`;
}

export { refusalFollowUp, refusalOf };

/**
 * The plugin’s files, by path under its folder. Pure, so the tests can check them.
 * @param {{ mcpUrl: string, rules: string, hookCommand?: string|null, hookTimeout?: number }} opts
 */
export const agyPlugin = ({ mcpUrl, rules, hookCommand = null, hookTimeout = HOOK_TIMEOUT_S }) => ({
  'plugin.json': `${JSON.stringify({ name: POSTBOX_SERVER })}\n`,
  'mcp_config.json': `${JSON.stringify({ mcpServers: { [POSTBOX_SERVER]: { serverUrl: mcpUrl } } }, null, 2)}\n`,
  'rules/AGENTS.md': rules,
  ...(hookCommand ? { 'hooks.json': `${JSON.stringify(agyHooksJson(hookCommand, hookTimeout), null, 2)}\n` } : {}),
});
/** Where the plugin goes in the agent’s folder. */
export const PLUGIN_DIR = join('.agents', 'plugins', POSTBOX_SERVER);

const firstSentence = (s, n = 300) => clip(/^[\s\S]*?[.!?](?=\s|$)/.exec(String(s ?? '').trim())?.[0] ?? s, n);

// How agy refuses a call it would ask about, headless (recorded): the step ends in ERROR with “permission check
// failed for …: user denied permission …”, and the result lists it in denied_actions. The turn still succeeds.
export const REFUSED = /permission check failed|user denied permission/;
// agy words a refusal as the person’s answer, but nobody was asked: the step says what happened instead.
/**
 * A tool step’s id in Postbox: its conversation and its index there, which grows across the conversation’s turns.
 * The UAT’s checks match refused steps by it (tools/uat/checks.mjs), so two agents’ steps never share one.
 */
export const stepId = (s) => `agy-${String(s?.conversation_id ?? '').slice(0, 8)}-${s?.step_index}`;
/** A step’s label: Claude Code’s words for a tool Postbox knows, else agy’s name for it, spaced out. */
const labelOf = ({ name, input }) =>
  name.startsWith('mcp__') || Object.keys(input).length || name === 'ToolSearch' ? describeTool(name, input) : clip(name.replace(/_/g, ' '), 80);

// A refusal agy doesn’t mark on its step (recorded: with --mode auto unavailable for the account, the command’s
// step ended DONE with no output, and only the result’s denied_actions said it was refused). Each one, by its
// display_name (RunCommand is run_command), is the last step of that tool that ended done with no output.
const deniedAfter = (actions, st, ctx) => {
  for (const a of Array.isArray(actions) ? actions : []) {
    const name = String(a?.display_name ?? '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
    const t = [...st.tools.values()].reverse().find((x) => x.name === name && x.state === 'done' && !x.output);
    if (!t) continue;
    t.state = 'denied';
    if (t === [...st.tools.values()].at(-1) && !st.textSinceTool) st.refusedLast = t.label;
    if (!t.quiet) ctx.activity({ id: t.id, label: t.label, state: 'denied', ms: t.ms, detail: refusalOf(ctx.persona?.permissionMode) });
  }
};

/**
 * Turns agy’s stream-json output into Postbox’s turn context. Every line is { event, … }: init (the conversation,
 * the model and the tools), then step_update for each step (user_input, system_message, agent_response with its
 * text_delta, tool with its state: ACTIVE, DONE or ERROR), then result. Pure apart from the ctx calls, so recorded
 * streams can test it.
 * @param {any} ctx @param {{ now?: () => number, effort?: string|null, resumed?: string|null, wrote?: boolean }} [opts]
 *   resumed: the conversation the turn asked for, if any; wrote: the reply already has text (a follow-up run)
 */
export function createAgyMapper(ctx, { now = Date.now, effort = null, resumed = null, wrote = false } = {}) {
  const st = {
    sessionId: /** @type {string|null} */ (null),
    model: /** @type {string|null} */ (null),
    contextWindow: agyWindowFor(ctx?.persona?.model),
    ctx: /** @type {number|null} */ (null),
    finished: /** @type {any} */ (null),
    error: /** @type {string|null} */ (null),
    missingSession: false,
    wrote,
    // The refused call the turn ended on, with nothing said after it: agy ends a turn at a refusal.
    refusedLast: /** @type {string|null} */ (null),
    textSinceTool: false,
    // Whether a model call failed, and whether the turn went on after the last one (agy retries a failed call).
    retried: false,
    // Whether the model got anywhere this turn (a tool step or a reply), and whether the last thing was a failed call.
    went: false,
    stuck: false,
    afterTool: wrote,
    tools: new Map(),
    state: /** @type {string|null} */ (null),
  };
  const status = (patch) => {
    if (patch.state && patch.state === st.state && Object.keys(patch).length === 1) return;
    if (patch.state) st.state = patch.state;
    ctx.status(patch);
  };
  if (!st.contextWindow) status({ ctx: null });
  const key = (s) => `${s.conversation_id ?? ''}:${s.step_index}`;
  const startTool = (s) => {
    const tool = toolOf(s);
    const t = {
      id: stepId(s),
      name: String(s.tool_name ?? s.tool_info?.name ?? ''),
      label: labelOf(tool),
      quiet: tool.quiet,
      started: now(),
      done: false,
      /** @type {string|null} */ state: null,
      output: false,
      ms: 0,
      // agy reading its own files isn’t the agent’s work (see AGY_FILE), so the work ledger doesn’t hear of it.
      work: tool.name !== 'ToolSearch',
    };
    st.tools.set(key(s), t);
    if (t.work) ctx.toolUse?.({ id: t.id, name: tool.name, input: tool.input });
    st.refusedLast = null;
    st.textSinceTool = false;
    if (!t.quiet) ctx.activity({ id: t.id, label: t.label, state: 'running' });
    status({ state: 'tool', currentStep: t.label });
    st.afterTool = true;
    return t;
  };
  const endTool = (s) => {
    const t = st.tools.get(key(s)) ?? startTool(s);
    if (t.done) return;
    t.done = true;
    const failed = s.state === 'ERROR';
    const why = failed ? String(s.tool_info?.error?.message ?? '') : '';
    const refused = failed && REFUSED.test(why);
    const hookWhy = failed ? (/^.*denied by (?:pre-tool|PreToolUse) hook:\s*(.*)$/is.exec(why)?.[1] ?? null) : null;
    const state = refused || hookWhy !== null ? 'denied' : failed ? 'failed' : 'done';
    const detail = refused ? refusalOf(ctx.persona?.permissionMode) : failed ? firstSentence(hookWhy || why || 'It failed without saying why.', 300) : '';
    const ms = typeof s.duration_seconds === 'number' ? Math.round(s.duration_seconds * 1000) : now() - t.started;
    Object.assign(t, { state, ms, output: s.tool_info?.output !== undefined });
    if (t.work) ctx.toolResult?.(agyResult(t.id, s, failed));
    if (refused) st.refusedLast = t.label;
    // Postbox’s own tools stay quiet, unless agy refused one: then the allow rule in your settings is missing.
    const ownRefused = `Antigravity refused Postbox’s own tool. Add "${ALLOW_POSTBOX}" to permissions.allow in your agy settings.`;
    if (refused && t.quiet) ctx.activity({ id: t.id, label: t.label, state, ms, detail: ownRefused });
    else if (!t.quiet) ctx.activity({ id: t.id, label: t.label, state, ms, ...(detail ? { detail } : {}) });
    // The model thinks next, and agy sends nothing until that step is done (recorded: 14 s after read_conversation in
    // the Gemini room UAT, with the ring still on the tool). So the ring says so now, as Claude Code’s does.
    status({ state: 'think', currentStep: 'Thinking' });
  };
  const step = (s) => {
    if (s?.step_type === 'tool' || s?.step_type === 'agent_response') {
      st.went = true;
      st.stuck = false;
    }
    if (s?.usage) {
      const pct = agyContextPercent(s.usage, st.contextWindow);
      if (pct !== null && pct !== st.ctx) {
        st.ctx = pct;
        status({ ctx: pct });
      } else if (!st.contextWindow) {
        status({ ctx: null });
      }
    }
    switch (s?.step_type) {
      case 'agent_response': {
        const text = typeof s.text_delta === 'string' ? s.text_delta : '';
        if (!text) {
          if (s.state === 'ACTIVE' && st.state !== 'gen') status({ state: 'think', currentStep: 'Thinking' });
          return;
        }
        // Text after a tool call is a new paragraph.
        if (st.wrote && st.afterTool) ctx.text('\n\n');
        st.afterTool = false;
        st.wrote = true;
        st.refusedLast = null;
        st.textSinceTool = true;
        if (st.state !== 'gen') status({ state: 'gen', currentStep: 'Writing a reply' });
        ctx.text(text);
        return;
      }
      case 'tool':
        if (s.state === 'DONE' || s.state === 'ERROR') endTool(s);
        else if (!st.tools.has(key(s))) startTool(s);
        return;
      // A model call that failed, which agy retries; the step says nothing more (recorded in the Gemini room UAT:
      // its log had “INTERNAL (code 500)” for each one). Without this the ring said Thinking for minutes.
      case 'error_message':
        st.retried = true;
        st.stuck = true;
        status({ state: 'think', currentStep: 'The model returned an error; Antigravity is retrying' });
        return;
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
    /** The label of the refused call the turn ended on, with nothing said after it; else null. */
    get endedOnRefusal() {
      return st.refusedLast;
    },
    /** Whether the reply has text. */
    get wrote() {
      return st.wrote;
    },
    /** The turn asked for a conversation agy no longer has, and agy started a new one. */
    get missingSession() {
      return st.missingSession;
    },
    push(e) {
      // Once the conversation is known to be the wrong one, the rest of the run is ignored: it’s stopped.
      if (st.missingSession) return;
      switch (e?.event) {
        case 'init': {
          const id = typeof e.conversation_id === 'string' && e.conversation_id ? e.conversation_id : null;
          if (resumed && id && id !== resumed) {
            st.missingSession = true;
            return;
          }
          st.sessionId = id;
          const model = typeof e.init?.model === 'string' && e.init.model ? e.init.model : null;
          if (model) {
            st.model = model;
            st.contextWindow = agyWindowFor(model);
            if (!st.contextWindow) status({ ctx: null });
            const ran = effortRun(model, effort);
            ctx.reported?.({ model, ...(ran ? { effort: ran } : {}) });
          }
          status({ state: 'think', currentStep: 'Thinking' });
          return;
        }
        case 'step_update':
          step(e.step_update);
          return;
        case 'result': {
          const r = e.result ?? {};
          st.finished = r;
          deniedAfter(r.denied_actions, st, ctx);
          if (st.ctx === null && r.usage) {
            const pct = agyContextPercent(r.usage, st.contextWindow);
            if (pct !== null) {
              st.ctx = pct;
              status({ ctx: pct });
            } else if (!st.contextWindow) {
              status({ ctx: null });
            }
          }
          if (r.status === 'SUCCESS') return;
          const why = clip(r.error || r.status || 'no reason given', 400);
          // agy’s ERROR doesn’t say how the turn ended. Recorded in the Gemini room UAT: ERROR after a model call it
          // retried and went on from, once with the review written in full and once ending at a refused command;
          // and ERROR (“API error (attempt 2)”) on a turn with no failed call in its stream, which a refused read
          // ended. Failing those would blame the wrong thing and offer a Retry that does it all again. So the stream
          // decides: the turn fails if the model got nowhere, or if the last thing in it was a failed call (the
          // retries ran out). Otherwise the error is a step, and the turn stands; a refusal shows as its own step.
          if (st.went && !st.stuck) {
            ctx.activity(
              st.retried
                ? { id: 'agy-retried', label: 'Antigravity retried after a model error', state: 'done', detail: why }
                : { id: 'agy-error', label: 'Antigravity reported an error as the turn ended', state: 'failed', detail: why },
            );
            return;
          }
          st.error = `Antigravity couldn’t run the turn: ${why}`;
          return;
        }
        default:
      }
    },
  };
}

/** Why a turn failed, from its exit code, when the stream didn’t say. agy logs to a file, so stderr is short. */
export function exitError(code, stderr = '') {
  const why = String(stderr)
    .split('\n')
    .filter((l) => l.trim() && !/^warning:/i.test(l))
    .slice(-3)
    .join(' ')
    .slice(0, 400);
  return `Antigravity exited with code ${code}${why ? `: ${why}` : ''}.`;
}

/**
 * One turn at a time per folder: each turn’s plugin holds its own conversation’s MCP URL, so a second turn in the
 * same folder would overwrite the first’s, and the first’s cleanup would remove the second’s.
 */
export class FolderQueue {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.tails = new Map();
  }
  /** Whether a turn is running, or waiting, in the folder. */
  busy(dir) {
    return this.tails.has(resolve(dir));
  }
  /** @template T @param {string} dir @param {() => Promise<T>} fn @returns {Promise<T>} */
  async run(dir, fn) {
    const k = resolve(dir);
    const before = this.tails.get(k) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const mine = new Promise((ok) => {
      release = () => ok(undefined);
    });
    const tail = before.then(() => mine);
    this.tails.set(k, tail);
    try {
      await before;
      return await fn();
    } finally {
      release();
      if (this.tails.get(k) === tail) this.tails.delete(k);
    }
  }
}

/**
 * The repository’s exclude file for a folder, or null outside a git repository. Read from the files, without git:
 * the nearest .git above the folder is the repository’s folder, or, in a worktree or a submodule, a file that names
 * it (“gitdir: …”). A worktree shares its main repository’s exclude file, which its commondir names.
 */
export async function excludeFile(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    const pointer = await readFile(git, 'utf8').catch((e) => (e?.code === 'EISDIR' ? '' : null));
    if (pointer === '') return join(git, 'info', 'exclude');
    const gitdir = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
    if (gitdir) {
      const own = resolve(dir, gitdir);
      const common = (await readFile(join(own, 'commondir'), 'utf8').catch(() => '')).trim();
      return join(common ? resolve(own, common) : own, 'info', 'exclude');
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Adds the plugin folder to the repository’s exclude file, once, so it never shows in git status. */
export async function excludePlugin(cwd) {
  const file = await excludeFile(cwd);
  if (!file) return false;
  const text = await readFile(file, 'utf8').catch(() => '');
  const line = `${PLUGIN_DIR.split('\\').join('/')}/`;
  if (text.split('\n').includes(line)) return true;
  await mkdir(dirname(file), { recursive: true });
  // Written beside it and renamed, so git never reads half a file.
  const tmp = `${file}.postbox-${process.pid}`;
  await writeFile(tmp, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Postbox’s plugin for an Antigravity turn, there only while it runs\n${line}\n`);
  await rename(tmp, file);
  return true;
}

export class AntigravityCliAdapter {
  name = 'antigravity-cli';

  /**
   * @param {{ bin?: string, workRoot: string, models?: string[], version?: string|null, hookScript?: string, settingsFile?: string,
   *           spawnImpl?: typeof spawn, env?: NodeJS.ProcessEnv, kill?: typeof process.kill, listProcesses?: typeof listProcesses }} opts
   *   models: what agyModels found, offered in the model field; settingsFile: your agy settings
   */
  constructor({
    bin = findAgy(),
    workRoot,
    models = [],
    version = null,
    hookScript = HOOK_SCRIPT,
    settingsFile = agySettingsFile(),
    spawnImpl = spawn,
    env = process.env,
    kill = process.kill,
    listProcesses: list = listProcesses,
  }) {
    this.kill = kill;
    this.list = list;
    this.capabilities = { ...AGY_CAPABILITIES, ...(models.length ? { models } : {}) };
    this.models = models;
    this.version = version;
    this.hookScript = hookScript;
    this.bin = bin;
    this.workRoot = workRoot;
    this.settingsFile = settingsFile;
    this.spawn = spawnImpl;
    this.env = env;
    this.folders = new FolderQueue();
    /** @type {Promise<string>|null} */
    this.allowed = null;
    /** @type {Set<string>} */
    this.excluded = new Set();
  }

  /** The folder the agent works in, by the rule every backend shares (folder.mjs). */
  folderFor(persona, project) {
    return agentFolder(persona, project, this.workRoot);
  }

  async deliver(session, message, ctx) {
    const persona = ctx.persona;
    const cwd = await this.folderFor(persona, ctx.project);
    // Once a run, on the first turn rather than at startup, so your settings change only when you use this backend.
    this.allowed ??= allowPostbox(this.settingsFile).catch((e) => {
      console.error(`Postbox couldn’t add its allow rule to ${this.settingsFile}: ${e.message}`);
      return 'unreadable';
    });
    if ((await this.allowed) === 'unreadable')
      console.error(
        `Postbox couldn’t read ${this.settingsFile}, so Antigravity will refuse Postbox’s tools. Add "${ALLOW_POSTBOX}" to permissions.allow there.`,
      );
    const prompt = formatMessage(message, ctx.pathOf);
    // agy can’t turn tools off (agyRules says what’s off), and its 12,000-character rules file has no room for #131’s sections.
    const guide = agentGuide({ persona, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief, toolRules: null, setup: false });
    const useHook = persona?.permissionMode !== 'bypass' && agySupportsHooks(this.version);
    const rulesWith = (hooked) => agyRules({ persona, guide, schemas: join(dirname(this.settingsFile), 'mcp', AGY_SERVER), hooked });
    const rules = rulesWith(useHook);
    const addDirs = [...new Set([ctx.project?.folder, ...(ctx.addDirs ?? [])])].filter((d) => d && resolve(d) !== resolve(cwd));
    if (this.folders.busy(cwd)) ctx.status({ currentStep: 'Waiting for another Antigravity turn in this folder' });
    await this.folders.run(cwd, async () => {
      if (ctx.signal.aborted) return;
      const plugin = join(cwd, PLUGIN_DIR);
      if (!this.excluded.has(cwd)) {
        this.excluded.add(cwd);
        await excludePlugin(cwd).catch(() => false);
      }
      const hookCommand = useHook ? agyHookCommand(this.hookScript) : null;
      for (const [path, text] of Object.entries(agyPlugin({ mcpUrl: ctx.mcpUrl, rules, hookCommand }))) {
        const file = join(plugin, path);
        await mkdir(dirname(file), { recursive: true });
        if (path === 'hooks.json') await rm(file, { force: true }).catch(() => {});
        await writeFile(file, text, path === 'hooks.json' ? { mode: 0o444 } : undefined);
      }
      const hookConfirmed = Boolean(useHook && (await confirmAgyHook({ version: this.version, pluginDir: plugin, script: this.hookScript })));
      // A hook that didn’t check out isn’t passed, so agy refuses what it would ask about: the rules say so, not “a card”.
      if (useHook && !hookConfirmed) await writeFile(join(plugin, 'rules', 'AGENTS.md'), rulesWith(false));
      try {
        let done = await this.run({ ctx, cwd, addDirs, prompt, sessionId: ctx.state.agySessionId ?? null, hookConfirmed });
        // A conversation agy no longer has (its history was cleared, or the agent’s folder changed) starts over, once.
        if (done.missingSession && !ctx.signal.aborted) {
          ctx.saveState({ agySessionId: null });
          ctx.state.agySessionId = null;
          const note = '[Postbox] Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n';
          done = await this.run({ ctx, cwd, addDirs, prompt: note + prompt, sessionId: null, hookConfirmed });
        }
        // agy ends a turn at a refused call, before the agent says anything (the Gemini room UAT’s tester rated that
        // high: the person saw a refused step and silence). So the conversation goes on once, for the agent to say
        // what was refused and carry on. A refusal in that run isn’t followed up again.
        if (done.endedOnRefusal && !ctx.signal.aborted && ctx.state.agySessionId) {
          ctx.status({ state: 'think', currentStep: 'Telling you about the refused call' });
          const followUp = refusalFollowUp(done.endedOnRefusal);
          await this.run({ ctx, cwd, addDirs, prompt: followUp, sessionId: ctx.state.agySessionId, wrote: done.wrote, hookConfirmed });
        }
      } finally {
        await rm(plugin, { recursive: true, force: true }).catch(() => {});
        // The folders above it, only if the plugin was all they held.
        for (const dir of [dirname(plugin), dirname(dirname(plugin))]) await rmdir(dir).catch(() => {});
      }
    });
  }

  /**
   * @param {{ ctx: any, cwd: string, addDirs: string[], prompt: string, sessionId: string|null, wrote?: boolean, hookConfirmed?: boolean }} turn
   * @returns {Promise<{ missingSession?: boolean, endedOnRefusal?: string|null, wrote?: boolean }>}
   */
  run({ ctx, cwd, addDirs, prompt, sessionId, wrote = false, hookConfirmed = false }) {
    const persona = ctx.persona;
    const model = agyModel(persona, this.models);
    const effort = agyEffort(model, effortOf(persona));
    const args = agyArgs({ persona, model, effort, sessionId, prompt, addDirs, hookConfirmed });
    const mapper = createAgyMapper(ctx, { effort, resumed: sessionId, wrote });
    const hookVars = {
      POSTBOX_MCP_URL: ctx.mcpUrl,
      POSTBOX_AGY_MODE: persona?.permissionMode ?? 'auto',
      POSTBOX_AGY_FOLDERS: JSON.stringify([cwd, ...addDirs]),
    };
    const env = hookConfirmed ? { ...this.env, ...hookVars } : this.env;
    return new Promise((resolve, reject) => {
      let child;
      try {
        // Its own process group, so Stop reaches everything it started (#126).
        child = this.spawn(this.bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        reject(new Error(`Couldn’t start the Antigravity CLI (${this.bin}): ${e.message}`));
        return;
      }
      let stderr = '';
      const c = child;
      const exited = new Promise((r) => {
        c.once('exit', r);
        c.once('close', r);
        c.once('error', r);
      });
      // SIGINT to the group, then SIGKILL after the grace period (process-group.mjs), as for the other CLIs.
      /** @type {Promise<{ gone: Promise<void> }>|null} */
      let stopping = null;
      const stop = () => {
        stopping ??= stopTurn(c, { exited, kill: this.kill, list: this.list });
      };
      if (ctx.signal.aborted) stop();
      else ctx.signal.addEventListener('abort', stop, { once: true });
      child.on('error', (e) =>
        reject(
          new Error(
            e.code === 'ENOENT'
              ? 'The Antigravity CLI isn’t installed, or isn’t on the PATH. Install it, or set POSTBOX_AGY_BIN.'
              : `The Antigravity CLI couldn’t start: ${e.message}`,
          ),
        ),
      );
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      const record = recorderFor(ctx, this.env.POSTBOX_AGY_RECORD, 'antigravity-cli');
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
          console.error(`Postbox couldn’t read an Antigravity CLI event: ${err.message}`);
        }
        // agy started a new conversation in place of the one asked for: stop it, and start over with a note.
        if (mapper.missingSession) return stop();
        // Saved as soon as it’s known, so a turn you stop still resumes next time.
        if (mapper.sessionId && mapper.sessionId !== ctx.state.agySessionId) {
          ctx.state.agySessionId = mapper.sessionId;
          ctx.saveState({ agySessionId: mapper.sessionId });
        }
      });
      const finish = (code) => {
        ctx.signal.removeEventListener('abort', stop);
        if (mapper.missingSession) return resolve({ missingSession: true });
        if (mapper.model) ctx.saveState({ model: mapper.model });
        if (ctx.signal.aborted) return resolve({});
        if (mapper.error) return reject(new Error(mapper.error));
        if (code !== 0 || !mapper.finished) return reject(new Error(exitError(code, stderr)));
        resolve({ endedOnRefusal: mapper.endedOnRefusal, wrote: mapper.wrote });
      };
      // A stopped turn ends once agy's whole group has exited, so the next turn can’t resume beside it (#126).
      child.on('close', (code) => {
        if (stopping) stopping.then((r) => r.gone).then(() => finish(code));
        else finish(code);
      });
    });
  }
}
