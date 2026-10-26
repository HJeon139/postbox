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
//
// On a remote host (#120, ctx.remote), the same arguments run there through the host’s daemon: see
// server/adapters/claude-code-remote.mjs for how a remote turn differs.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeArgs } from './claude-code-args.mjs';
import { attachmentPaths, CLAUDE_CODE_CAPABILITIES, checkRemoteClaude, hostTurns, remoteGuide, remoteSaid, remoteTurn } from './claude-code-remote.mjs';
import { createStreamMapper, forkPointMissing, resultError, windowFor } from './claude-stream.mjs';
import { agentFolder } from './folder.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { listProcesses, stopJobUnder, stopTurn } from './process-group.mjs';
import { effortOf, recorderFor } from './setup.mjs';

export { claudeArgs } from './claude-code-args.mjs';
export { CLAUDE_CODE_CAPABILITIES, DENY_PROMPTS_MIN, REMOTE_CLAUDE_MIN, remoteClaudeProblem } from './claude-code-remote.mjs';

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

/**
 * Where a forked session starts: the checkpoint of the message it branched from, or, for a reply from
 * before checkpoints were kept, the latest point of the session it forks.
 */
export function forkPoint(state) {
  if (state.fork?.claudeSessionId) return state.fork;
  const from = state.forkFrom?.claudeSessionId;
  return from ? { claudeSessionId: from } : null;
}

/**
 * Reads the CLI’s stream-json from `child` into `mapper`, handing each line to recorderFor (POSTBOX_CLAUDE_RECORD, a
 * recorded room’s telemetry), and saving the session ID when the init event names a new one.
 * @param {any} ctx @param {any} child @param {ReturnType<typeof createStreamMapper>} mapper
 */
function readStream(ctx, child, mapper) {
  const record = recorderFor(ctx, process.env.POSTBOX_CLAUDE_RECORD, 'claude-code');
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    record(line);
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
    const remote = ctx.remote ?? null;
    const attach = remote?.attach?.turn ?? null;
    if (remote) checkRemoteClaude(remote, Boolean(attach));
    const cwd = remote ? remote.folder : await this.folderFor(persona, ctx.project);
    // On a host, each attachment is its copy in the folder of the host turn the message goes to.
    const promptOn = (/** @type {string | null} */ turn) => formatMessage(message, attachmentPaths(ctx, turn));
    const local = agentGuide({ persona, session, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief });
    const guide = remote ? remoteGuide(local, cwd, ctx.addDirs ?? []) : local;
    // The project’s folder, and the folders the person added for this conversation (#66). On a host, none: they’re
    // paths on this computer, and the project’s folder there is cwd.
    const addDirs = remote ? [] : [...new Set([ctx.project?.folder, ...(ctx.addDirs ?? [])])].filter((d) => d && d !== cwd);
    // A turn already on the host, after a restart: replayed, never started again.
    if (attach) {
      await this.run({ ctx, cwd, prompt: promptOn(attach), guide, resume: true, sessionId: ctx.state.claudeSessionId ?? null, turn: attach, attach: true });
      return;
    }
    const fork = !ctx.state.claudeSessionId ? forkPoint(ctx.state) : null;
    const hostTurn = hostTurns(remote);
    let turn = await hostTurn();
    let first = await this.run({
      ctx,
      cwd,
      addDirs,
      prompt: promptOn(turn),
      guide,
      resume: Boolean(ctx.state.claudeSessionId),
      sessionId: ctx.state.claudeSessionId,
      fork,
      turn,
    });
    // A branch point Claude Code can no longer find (#61): fork from the conversation’s latest point instead,
    // once. The fork is saved without its uuid first, so a later turn never goes back to the bad one.
    if (first.missingForkPoint && fork) {
      const latest = { claudeSessionId: fork.claudeSessionId };
      ctx.saveState({ claudeSessionId: null, fork: latest });
      const note = '[Postbox] This thread couldn’t start at the message it branched from, so it starts from the conversation’s latest message.\n\n';
      turn = await hostTurn();
      first = await this.run({ ctx, cwd, addDirs, prompt: note + promptOn(turn), guide, resume: false, sessionId: null, fork: latest, turn });
    }
    // A session Claude Code no longer has (its history was cleared) starts over, once.
    if (first.missingSession) {
      ctx.saveState({ claudeSessionId: null });
      const note = '[Postbox] Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n';
      turn = await hostTurn();
      await this.run({ ctx, cwd, addDirs, prompt: note + promptOn(turn), guide, resume: false, sessionId: null, turn });
    }
  }

  /**
   * @param {{ ctx: any, cwd: string, addDirs?: string[], prompt: string, guide: string, resume: boolean, sessionId: string|null, fork?: any,
   *   turn: string | null, attach?: boolean }} o  turn: the host turn this run is, on a host (null here); attach: it’s
   *   already there, after a restart
   */
  run({ ctx, cwd, addDirs = [], prompt, guide, resume, sessionId, fork = null, turn, attach = false }) {
    const id = sessionId ?? randomUUID();
    // A resume (not a fork, not a fresh start) of a turn the host lost goes on with it (D2).
    const remote = ctx.remote && turn ? remoteTurn(ctx.remote, cwd, turn, Boolean(resume && !fork && ctx.remote.resumeInterrupted), attach) : null;
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
      ...(remote ? { server: remote.server, denyPrompts: ctx.remote.settings?.denyPrompts === true } : {}),
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
        // On a host, cwd and env are the remote spawn’s own (remoteTurn): these are ignored there.
        child = (remote ? remote.spawnImpl : this.spawn)(this.bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        reject(new Error(remote ? `Couldn’t start Claude Code on the host: ${e.message}` : `Couldn’t start Claude Code (${this.bin}): ${e.message}`));
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
      // reported with their process group so the person can stop them later. On a host none is kept (the daemon stops
      // the whole turn): one the runtime asked to keep anyway is reported stopped, not kept.
      const onAbort = () => {
        const keep = Array.isArray(ctx.signal.reason?.keepJobs) ? ctx.signal.reason.keepJobs : [];
        stopping = stopTurn(child, { keep, exited, ...procs }).then((r) => {
          for (const k of r.kept) ctx.job?.({ id: k.id, kept: true, pgid: k.pgid, groups: k.groups });
          if (remote) for (const k of keep) if (typeof k?.id === 'string') ctx.job?.({ id: k.id, state: 'stopped' });
          return r;
        });
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      // A background job’s own Stop, while the CLI waits for it. Not offered on a host (stopJobUnder would refuse it
      // there too): the runtime then says the job can’t be reached, and to stop the agent.
      if (!remote) ctx.control?.({ stopJob: (job) => stopJobUnder(child, job, procs) });
      child.on('error', (e) =>
        reject(
          new Error(
            remote
              ? `Claude Code couldn’t run on the host: ${e.message}`
              : e.code === 'ENOENT'
                ? 'Claude Code isn’t installed, or isn’t on the PATH. Install it, or set POSTBOX_CLAUDE_BIN.'
                : `Claude Code couldn’t start: ${e.message}`,
          ),
        ),
      );
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      readStream(ctx, child, mapper);
      const done = (code) => {
        if (finished) return;
        finished = true;
        ctx.signal.removeEventListener('abort', onAbort);
        // A fork whose branch point is gone keeps nothing from this run: no session id, no checkpoint.
        if (fork?.uuid && !ctx.signal.aborted && forkPointMissing(mapper.result, stderr)) return resolve({ missingForkPoint: true });
        ctx.saveState({ ...mapper.endState, ...(mapper.sessionId ? { fork: null } : {}) });
        const current = mapper.sessionId ?? ctx.state.claudeSessionId;
        if (mapper.lastUuid && current) ctx.checkpoint?.({ claudeSessionId: current, uuid: mapper.lastUuid });
        if (ctx.signal.aborted) return resolve({});
        // A session to resume or fork that Claude Code no longer has. On a host, the result says it too (remoteSaid).
        const said = remote ? remoteSaid(stderr, mapper.result) : stderr;
        if ((resume || fork) && /No conversation found|session .* not found/i.test(said)) return resolve({ missingSession: true });
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
