// The Claude Code backend: each turn runs the claude CLI you’re already signed in to, in print mode with
// stream-json output, and resumes the same Claude Code session next turn. Postbox never sees a key or a
// token: the CLI uses your own sign-in.
//
//   claude -p --output-format stream-json --include-partial-messages --verbose
//          --thinking-display summarized --forward-subagent-text
//          --model <persona model>  --effort <persona effort>  --session-id <uuid> | --resume <uuid>
//          --mcp-config '{ postbox: { type: http, url: <ctx.mcpUrl>, alwaysLoad, timeout: 25 h } }'  [--strict-mcp-config (Isolated)]
//          --append-system-prompt <guide>  --allowedTools mcp__postbox [rules allowed once after a refusal]
//          --setting-sources user,project,local | project,local (Isolated)
//          --settings '{"outputStyle":"default", "deniedMcpServers": [servers the persona turned off],
//                       "permissions": { "ask": [writes outside Postbox (all but bypass), the conversation’s] }}'
//          --disallowedTools <tools that publish outside Postbox (unless the persona can publish), the tools of
//                            unticked Tools, and tools that act outside Postbox (unless it allows them)>
//          --permission-mode auto | manual | acceptEdits | bypassPermissions
//          --permission-prompt-tool mcp__postbox__permission_prompt   (all but bypass: what auto can’t decide comes here)
//
// Your own setup (skills, commands, plugins, permission rules, MCP servers and claude.ai connectors) loads as in
// your terminal, with Postbox’s server added, except the output style, the servers the persona turned off, and
// the tools that publish outside Postbox: see server/adapters/setup.mjs. An Isolated persona gets
// --strict-mcp-config, so only Postbox’s server loads (#59).
// The turn’s message goes in on stdin. The CLI runs in its own process group: Stop sends it SIGINT, then SIGKILL if it
// doesn’t exit, and to every tool shell it started (server/adapters/process-group.mjs, #126).
// POSTBOX_CLAUDE_RECORD=<folder> saves each turn’s raw stream there, for test fixtures.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { withAskRules } from '../permission-rules.mjs';
import { createStreamMapper, forkPointMissing, resultError, windowFor } from './claude-stream.mjs';
import { agentFolder } from './folder.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { listProcesses, stopJobUnder, stopTurn } from './process-group.mjs';
import { deniedTools, effortOf, HOST_SOURCES, ISOLATED_SOURCES, modelOf, postboxServer, settingsFor, setupOf, writeRules } from './setup.mjs';

// Every mode is passed explicitly: left out, Claude Code would take permissions.defaultMode from your own
// settings, or auto, and an agent you set to ask could end up not asking. (manual is the CLI’s name for default.)
const MODES = {
  auto: ['--permission-mode', 'auto'],
  ask: ['--permission-mode', 'manual'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  bypass: ['--permission-mode', 'bypassPermissions'],
};

/**
 * What this backend can do, for the runtime and the UI (#117). Left out, it forks, reads rules and offers Claude’s
 * models. On a remote host (#120), the message goes in a file, it sets no variable of its own, Postbox’s server goes
 * in --mcp-config, a quiet tool call still prints tool_progress, and a sign-in that ran out ends the turn with an
 * authentication_failed result.
 */
export const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  remote: Object.freeze({
    stdin: 'file',
    env: Object.freeze([]),
    server: 'mcp-config',
    work: 'events',
    signInError: Object.freeze({ type: 'result', is_error: true, error: 'authentication_failed' }),
  }),
});

/** The claude binary: POSTBOX_CLAUDE_BIN, then the native installer’s location, then the PATH. */
export function findClaude(env = process.env) {
  if (env.POSTBOX_CLAUDE_BIN) return env.POSTBOX_CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

/** The installed version, or null if the CLI can’t be run. */
export function claudeVersion(bin = findClaude()) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split(/\s/)[0] || 'unknown' : null);
    });
  });
}

/** The CLI arguments for one turn. Pure, so the tests can check them. */
/**
 * @param {{ persona: any, sessionId: string, resume: boolean, mcpUrl: string, guide: string, addDirs?: string[],
 *           fork?: { claudeSessionId: string, uuid?: string }|null, allowOnce?: string[], rules?: { allow?: string[], ask?: string[], deny?: string[] } }} turn
 *   rules: the ones the person made for this conversation only (#66), passed every turn
 */
export function claudeArgs({ persona, sessionId, resume, mcpUrl, guide, addDirs = [], fork = null, allowOnce = [], rules = {} }) {
  const mode = persona.permissionMode in MODES ? persona.permissionMode : 'auto';
  const setup = setupOf(persona);
  const denied = [...deniedTools(persona), ...(rules.deny ?? [])];
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Readable thinking, and subagents’ own messages, so Postbox can show what the agent is on.
    '--thinking-display',
    'summarized',
    '--forward-subagent-text',
    // Both always passed, as the permission mode is: left out, your own settings would decide (#60).
    '--model',
    modelOf(persona),
    '--effort',
    effortOf(persona),
    // A topic thread’s first turn forks the conversation’s session at the message it branched from.
    ...(fork
      ? ['--resume', fork.claudeSessionId, '--fork-session', ...(fork.uuid ? ['--resume-session-at', fork.uuid] : [])]
      : resume
        ? ['--resume', sessionId]
        : ['--session-id', sessionId]),
    // Postbox’s server, next to your own; an Isolated persona loads Postbox’s only.
    '--mcp-config',
    JSON.stringify({ mcpServers: postboxServer(mcpUrl) }),
    ...(setup.usesHostSetup ? [] : ['--strict-mcp-config']),
    '--append-system-prompt',
    guide,
    // Postbox’s own tools never need asking: they only show things in the thread.
    '--allowedTools',
    'mcp__postbox',
    // Rules the person allowed once, after a refusal, for this turn only, and those for this conversation (#66).
    ...allowOnce,
    ...(rules.allow ?? []),
    // The person’s Claude Code setup (or the project’s only, when Isolated), with the default output style,
    // without the MCP servers the persona turned off, and without the tools it may not use: those that publish
    // or act outside Postbox, and its unticked Tools (server/adapters/setup.mjs).
    '--setting-sources',
    (setup.usesHostSetup ? HOST_SOURCES : ISOLATED_SOURCES).join(','),
    '--settings',
    // With ask rules for writes outside Postbox (#112), so each comes to a card first, and the conversation’s own.
    JSON.stringify(withAskRules(settingsFor(persona), [...writeRules(persona), ...(rules.ask ?? [])])),
    ...(denied.length ? ['--disallowedTools', ...denied] : []),
    ...MODES[mode],
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    ...(mode === 'bypass' ? [] : ['--permission-prompt-tool', 'mcp__postbox__permission_prompt']),
  ];
}

/**
 * Where a forked session starts: the checkpoint of the message it branched from, or, for a reply from
 * before checkpoints were kept, the latest point of the session it forks.
 */
export function forkPoint(state) {
  if (state.fork?.claudeSessionId) return state.fork;
  const from = state.forkFrom?.claudeSessionId;
  return from ? { claudeSessionId: from } : null;
}

export class ClaudeCodeAdapter {
  name = 'claude-code';
  capabilities = CLAUDE_CODE_CAPABILITIES;

  /**
   * @param {{ bin?: string, workRoot: string, spawnImpl?: typeof spawn, kill?: import('./process-group.mjs').KillFn,
   *           listProcesses?: () => Promise<import('./process-group.mjs').Proc[]> }} opts
   *   kill and listProcesses: how Stop signals and finds processes; tests pass fakes
   */
  constructor({ bin = findClaude(), workRoot, spawnImpl = spawn, kill = process.kill, listProcesses: list = listProcesses }) {
    this.bin = bin;
    this.workRoot = workRoot;
    this.spawn = spawnImpl;
    this.kill = kill;
    this.list = list;
  }

  /** The folder the agent works in, by the rule every backend shares (folder.mjs). */
  folderFor(persona, project) {
    return agentFolder(persona, project, this.workRoot);
  }

  async deliver(session, message, ctx) {
    const persona = ctx.persona;
    const cwd = await this.folderFor(persona, ctx.project);
    const prompt = formatMessage(message, ctx.pathOf);
    const guide = agentGuide({ persona, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief });
    // The project’s folder, and the folders the person added for this conversation (#66).
    const addDirs = [...new Set([ctx.project?.folder, ...(ctx.addDirs ?? [])])].filter((d) => d && d !== cwd);
    const fork = !ctx.state.claudeSessionId ? forkPoint(ctx.state) : null;
    let first = await this.run({ ctx, cwd, addDirs, prompt, guide, resume: Boolean(ctx.state.claudeSessionId), sessionId: ctx.state.claudeSessionId, fork });
    // A branch point Claude Code can no longer find (#61): fork from the conversation’s latest point instead,
    // once. The fork is saved without its uuid first, so a later turn never goes back to the bad one.
    if (first.missingForkPoint && fork) {
      const latest = { claudeSessionId: fork.claudeSessionId };
      ctx.saveState({ claudeSessionId: null, fork: latest });
      const note = '[Postbox] This thread couldn’t start at the message it branched from, so it starts from the conversation’s latest message.\n\n';
      first = await this.run({ ctx, cwd, addDirs, prompt: note + prompt, guide, resume: false, sessionId: null, fork: latest });
    }
    // A session Claude Code no longer has (its history was cleared) starts over, once.
    if (first.missingSession) {
      ctx.saveState({ claudeSessionId: null });
      const note = '[Postbox] Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n';
      await this.run({ ctx, cwd, addDirs, prompt: note + prompt, guide, resume: false, sessionId: null });
    }
  }

  /** @param {{ ctx: any, cwd: string, addDirs?: string[], prompt: string, guide: string, resume: boolean, sessionId: string|null, fork?: any }} turn */
  run({ ctx, cwd, addDirs = [], prompt, guide, resume, sessionId, fork = null }) {
    const id = sessionId ?? randomUUID();
    const args = claudeArgs({
      persona: ctx.persona,
      sessionId: id,
      resume,
      mcpUrl: ctx.mcpUrl,
      guide,
      addDirs,
      fork,
      allowOnce: ctx.allowOnce ?? [],
      rules: ctx.rules ?? {},
    });
    const mapper = createStreamMapper(ctx, { contextWindow: ctx.state.contextWindow ?? windowFor(ctx.persona.model), effort: effortOf(ctx.persona) });
    // A subagent’s permission prompt arrives at Postbox’s MCP tool with its id; the stream knows its name.
    ctx.subagentNames?.((ids) => mapper.who(ids));
    // A fork gets its own id from Claude Code, saved when the init event arrives.
    if (!resume && !fork) ctx.saveState({ claudeSessionId: id });
    return new Promise((resolve, reject) => {
      let child;
      try {
        // Its own process group, so Stop reaches everything under a launcher too (#126).
        child = this.spawn(this.bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        reject(new Error(`Couldn’t start Claude Code (${this.bin}): ${e.message}`));
        return;
      }
      let stderr = '';
      let finished = false;
      const exited = new Promise((r) => {
        child.once('exit', r);
        child.once('close', r);
        child.once('error', r);
      });
      const procs = { kill: this.kill, list: this.list };
      /** @type {Promise<{ gone: Promise<void> }>|null} */
      let stopping = null;
      // Stop: the background jobs the runtime asked to keep running (ctx.signal.reason.keepJobs) are kept, and
      // reported with their process group so the person can stop them later.
      const onAbort = () => {
        const keep = Array.isArray(ctx.signal.reason?.keepJobs) ? ctx.signal.reason.keepJobs : [];
        stopping = stopTurn(child, { keep, exited, ...procs }).then((r) => {
          for (const k of r.kept) ctx.job?.({ id: k.id, kept: true, pgid: k.pgid, groups: k.groups });
          return r;
        });
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      // A background job’s own Stop, while the CLI waits for it.
      ctx.control?.({ stopJob: (job) => stopJobUnder(child, job, procs) });
      child.on('error', (e) =>
        reject(
          new Error(
            e.code === 'ENOENT'
              ? 'Claude Code isn’t installed, or isn’t on the PATH. Install it, or set POSTBOX_CLAUDE_BIN.'
              : `Claude Code couldn’t start: ${e.message}`,
          ),
        ),
      );
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      const record = process.env.POSTBOX_CLAUDE_RECORD ? join(process.env.POSTBOX_CLAUDE_RECORD, `${Date.now()}-${ctx.persona.handle}.jsonl`) : null;
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        if (record) appendFileSync(record, `${line}\n`);
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return; // not every line has to be JSON (a warning, say)
        }
        try {
          mapper.push(e);
        } catch (err) {
          console.error(`Postbox couldn’t read a Claude Code event: ${err.message}`);
        }
        if (e.type === 'system' && e.subtype === 'init' && e.session_id && e.session_id !== ctx.state.claudeSessionId) {
          ctx.saveState({ claudeSessionId: e.session_id });
        }
      });
      const done = (code) => {
        if (finished) return;
        finished = true;
        ctx.signal.removeEventListener('abort', onAbort);
        // A fork whose branch point is gone keeps nothing from this run: no session id, no checkpoint.
        if (fork?.uuid && !ctx.signal.aborted && forkPointMissing(mapper.result, stderr)) return resolve({ missingForkPoint: true });
        ctx.saveState({ contextWindow: mapper.contextWindow, model: mapper.model ?? undefined, ...(mapper.sessionId ? { fork: null } : {}) });
        const current = mapper.sessionId ?? ctx.state.claudeSessionId;
        if (mapper.lastUuid && current) ctx.checkpoint?.({ claudeSessionId: current, uuid: mapper.lastUuid });
        if (ctx.signal.aborted) return resolve({});
        // A session to resume or fork that Claude Code no longer has.
        if ((resume || fork) && /No conversation found|session .* not found/i.test(stderr)) return resolve({ missingSession: true });
        const failure = resultError(mapper.result);
        if (failure) {
          const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
          return reject(new Error(mapper.result ? failure : `Claude Code exited with code ${code}${why ? `: ${why}` : ''}.`));
        }
        resolve({});
      };
      // A stopped turn ends once its CLI’s whole group has exited, even if something it started still holds its output
      // open, so the session’s next turn never runs beside it (#126).
      const settle = (code) => {
        if (ctx.signal.aborted && stopping) stopping.then((r) => r.gone).then(() => done(code));
        else done(code);
      };
      child.on('close', settle);
      child.on('exit', (code) => {
        if (ctx.signal.aborted) settle(code);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}
