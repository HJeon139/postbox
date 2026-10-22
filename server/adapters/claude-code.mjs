// The Claude Code backend: each turn runs the claude CLI you’re already signed in to, in print mode with
// stream-json output, and resumes the same Claude Code session next turn. Postbox never sees a key or a
// token: the CLI uses your own sign-in.
//
//   claude -p --output-format stream-json --include-partial-messages --verbose
//          --thinking-display summarized --forward-subagent-text
//          --model <persona model>  --effort <persona effort>  --session-id <uuid> | --resume <uuid>
//          --mcp-config '{ postbox: { type: http, url: <ctx.mcpUrl>, alwaysLoad } }'  [--strict-mcp-config (Isolated)]
//          --append-system-prompt <guide>  --allowedTools mcp__postbox [rules allowed once after a refusal]
//          --setting-sources user,project,local | project,local (Isolated)
//          --settings '{"outputStyle":"default", "deniedMcpServers": [servers the persona turned off]}'
//          --disallowedTools <tools that publish outside Postbox (unless the persona can publish), the tools of
//                            unticked Tools, and tools that act outside Postbox (unless it allows them)>
//          --permission-mode auto | manual | acceptEdits | bypassPermissions
//          --permission-prompt-tool mcp__postbox__permission_prompt   (all but bypass: what auto can’t decide comes here)
//
// Your own setup (skills, commands, plugins, permission rules, MCP servers and claude.ai connectors) loads as in
// your terminal, with Postbox’s server added, except the output style, the servers the persona turned off, and
// the tools that publish outside Postbox: see server/adapters/setup.mjs. An Isolated persona gets
// --strict-mcp-config, so only Postbox’s server loads (#59).
// The turn’s message goes in on stdin. Stop sends SIGINT, then SIGKILL if the CLI doesn’t exit.
// POSTBOX_CLAUDE_RECORD=<folder> saves each turn’s raw stream there, for test fixtures.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createStreamMapper, forkPointMissing, resultError, windowFor } from './claude-stream.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { deniedTools, effortOf, HOST_SOURCES, ISOLATED_SOURCES, modelOf, postboxServer, settingsFor, setupOf } from './setup.mjs';

// Every mode is passed explicitly: left out, Claude Code would take permissions.defaultMode from your own
// settings, or auto, and an agent you set to ask could end up not asking. (manual is the CLI’s name for default.)
const MODES = {
  auto: ['--permission-mode', 'auto'],
  ask: ['--permission-mode', 'manual'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  bypass: ['--permission-mode', 'bypassPermissions'],
};

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
 *           fork?: { claudeSessionId: string, uuid?: string }|null, allowOnce?: string[] }} turn
 */
export function claudeArgs({ persona, sessionId, resume, mcpUrl, guide, addDirs = [], fork = null, allowOnce = [] }) {
  const mode = persona.permissionMode in MODES ? persona.permissionMode : 'auto';
  const setup = setupOf(persona);
  const denied = deniedTools(persona);
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
    // Rules the person allowed once, after a refusal, for this turn only.
    ...allowOnce,
    // The person’s Claude Code setup (or the project’s only, when Isolated), with the default output style,
    // without the MCP servers the persona turned off, and without the tools it may not use: those that publish
    // or act outside Postbox, and its unticked Tools (server/adapters/setup.mjs).
    '--setting-sources',
    (setup.usesHostSetup ? HOST_SOURCES : ISOLATED_SOURCES).join(','),
    '--settings',
    JSON.stringify(settingsFor(persona)),
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

  /** @param {{ bin?: string, workRoot: string, spawnImpl?: typeof spawn }} opts */
  constructor({ bin = findClaude(), workRoot, spawnImpl = spawn }) {
    this.bin = bin;
    this.workRoot = workRoot;
    this.spawn = spawnImpl;
  }

  /**
   * The folder the agent works in: the one its persona names, else its project’s root folder (where Claude
   * Code sessions start, per designs/intent.md), else a workspace of its own. Its permission mode decides
   * what it may change there.
   */
  async folderFor(persona, project) {
    const dir = persona.folder || project?.folder || join(this.workRoot, persona.handle);
    await mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  async deliver(session, message, ctx) {
    const persona = ctx.persona;
    const cwd = await this.folderFor(persona, ctx.project);
    const prompt = formatMessage(message, ctx.pathOf);
    const guide = agentGuide({ persona, handles: ctx.handles, project: ctx.project, brief: session?.brief });
    const addDirs = [ctx.project?.folder].filter((d) => d && d !== cwd);
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
    const args = claudeArgs({ persona: ctx.persona, sessionId: id, resume, mcpUrl: ctx.mcpUrl, guide, addDirs, fork, allowOnce: ctx.allowOnce ?? [] });
    const mapper = createStreamMapper(ctx, { contextWindow: ctx.state.contextWindow ?? windowFor(ctx.persona.model), effort: effortOf(ctx.persona) });
    // A fork gets its own id from Claude Code, saved when the init event arrives.
    if (!resume && !fork) ctx.saveState({ claudeSessionId: id });
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new Error(`Couldn’t start Claude Code (${this.bin}): ${e.message}`));
        return;
      }
      let stderr = '';
      /** @type {NodeJS.Timeout|undefined} */
      let killTimer;
      const onAbort = () => {
        child.kill('SIGINT');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
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
      child.on('close', (code) => {
        clearTimeout(killTimer);
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
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}
