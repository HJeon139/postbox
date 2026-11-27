// The Claude Code backend on a remote host (#120, ctx.remote; designs/architecture/remote-hosts.md “Remote hosts”): the same arguments run
// there through the host’s daemon (server/remote/process.mjs), with these differences:
// - Postbox’s server is the host’s stdio shim: { type: stdio, command: <host node>, args: [<shim.mjs>, <turn>],
//   timeout: the host’s permissionWaitMax plus an hour, alwaysLoad }, passed on every turn, resumes too (C1, C6).
// - The message’s attachments go with every start, and the message names their copies in that host turn’s folder.
// - The working folder is the host folder, and no --add-dir: the conversation’s added folders are on this computer, so
//   the agent guide says they aren’t there. The session lives in the host’s ~/.claude/projects.
// - The host’s claude must be 2.1.187 or later (C3), and 2.1.259 or later with the host’s denyPrompts on, which passes
//   --permission-prompts none instead of --permission-prompt-tool (D2). A resume after an interrupted turn sets
//   CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1, so the cut-off turn goes on (D2). Every turn sets CLAUDE_CODE_TERMINAL_MCP_TOOLS
//   to Postbox’s react, which the daemon adds to the host’s own list (#1712). No other variable crosses.
// - Stop goes through the daemon (process-group.mjs’s remote branch). Background jobs aren’t kept and have no Stop of
//   their own: the runtime doesn’t offer either for a remote turn, and a keep that reaches here anyway is reported stopped.
// - After a Postbox restart, ctx.remote.attach names a turn already on the host: it’s read from the start into a fresh
//   mapper (the reply is rebuilt whole), nothing is sent to it, and no fallback starts another.
// server/adapters/claude-code.mjs runs the turn; this module holds what only a host needs.

import { claudeMissing, claudeVersionProblem } from '../../shared/claude-version-check.mjs';
import { TERMINAL_TOOLS_VAR } from '../../shared/terminal-tools.mjs';
import { remoteSpawn } from '../remote/process.mjs';
import { checkRemoteContext } from './adapter.mjs';
import { hostShim, hostWaitMax, startAttachments } from './remote-turn.mjs';
import { PERMISSION_WAIT_MARGIN_MS, POSTBOX_REACT_TOOL, shimServer } from './setup.mjs';

export { attachmentPaths } from './remote-turn.mjs';

/**
 * What this backend can do, for the runtime and the UI (#117). Left out, it forks, reads rules and offers Claude’s
 * models. On a remote host (#120), the message goes in a file, the variables it sets are the resume of an interrupted
 * turn (D2) and the tools a turn may end on quietly (#1712), Postbox’s server goes in --mcp-config, a quiet tool call still prints tool_progress, a wait on a background task lists it (#847), and a sign-in that ran
 * out ends the turn with an authentication_failed result.
 */
export const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  images: true,
  skills: true,
  remote: Object.freeze({
    stdin: 'file',
    env: Object.freeze(['CLAUDE_CODE_RESUME_INTERRUPTED_TURN', TERMINAL_TOOLS_VAR]),
    server: 'mcp-config',
    work: 'events',
    backgroundTasks: 'background_tasks_changed',
    signInError: Object.freeze({ type: 'result', is_error: true, error: 'authentication_failed' }),
  }),
});

/**
 * Why a remote turn can’t start on this host’s claude, or null if it can: missing, a version it couldn’t read, or older
 * than REMOTE_CLAUDE_MIN (or DENY_PROMPTS_MIN with denyPrompts on). Each says what was found, and where.
 * @param {any} welcome  the daemon’s latest welcome  @param {{ denyPrompts?: boolean }} [settings]  the host’s
 */
export function remoteClaudeProblem(welcome, settings = {}) {
  if (!welcome) return 'Postbox hasn’t heard from the host’s daemon yet, so it can’t tell which Claude Code is there.';
  // A daemon that checks claude itself does so at the start, after looking for one installed since this welcome (#1084).
  if (welcome.claudeChecks === true) return null;
  const h = (Array.isArray(welcome.harnesses) ? welcome.harnesses : []).find((x) => x?.name === 'claude-code');
  if (!h?.path) return claudeMissing(h);
  return claudeVersionProblem(h, !!settings.denyPrompts);
}

/**
 * Refuses a turn before anything starts on the host: a host whose claude can’t run it as Postbox needs it (C3), or a
 * remote context without the runtime’s turn ID or Postbox’s version. An attach checks only the context.
 * @param {import('./adapter.mjs').RemoteContext} remote @param {boolean} attach
 */
export function checkRemoteClaude(remote, attach) {
  checkRemoteContext(remote, { attach });
  if (attach) return;
  const problem = remoteClaudeProblem(remote.welcome ?? remote.link?.welcome, remote.settings ?? {});
  if (problem) throw new Error(problem);
}

/**
 * The guide for a turn on a host, in `cwd` there: the conversation’s added folders are on Postbox’s computer, so it
 * says the agent can’t reach them.
 * @param {string} guide @param {string} cwd @param {string[]} [addDirs]  ctx.addDirs
 */
export function remoteGuide(guide, cwd, addDirs = []) {
  const left = [...new Set(addDirs)].filter(Boolean);
  return `${guide}\n\nThis turn runs on a remote host, in ${cwd}.${left.length ? ` The folders added to this conversation (${left.join(', ')}) are on Postbox’s computer, not this host, so you can’t reach them here.` : ''}`;
}

/**
 * The host turn each run is: the first is the runtime’s, and a fallback’s is a new one it allocates (and persists).
 * Null for every run here.
 * @param {any} remote  ctx.remote, or null
 * @returns {() => Promise<string | null>}
 */
export function hostTurns(remote) {
  let runs = 0;
  return async () => (remote ? (runs++ ? await remote.nextTurn() : remote.turn) : null);
}

/**
 * A remote turn’s Postbox server and variables, and the spawn that starts it on the host as `turn`, the runtime’s
 * ID (#120).
 * @param {import('./adapter.mjs').RemoteContext} remote  ctx.remote @param {string} folder @param {string} turn
 * @param {boolean} resumeInterrupted  set the variable that goes on with a cut-off turn
 * @param {boolean} [attach]  read the turn already on the host from the start, instead of starting it
 */
export function remoteTurn(remote, folder, turn, resumeInterrupted, attach = false) {
  const welcome = remote.welcome ?? remote.link?.welcome;
  const server = shimServer({ ...hostShim(remote, welcome, turn), timeout: hostWaitMax(remote) + PERMISSION_WAIT_MARGIN_MS });
  /** @type {Record<string, string>} */
  const set = { [TERMINAL_TOOLS_VAR]: POSTBOX_REACT_TOOL, ...(resumeInterrupted ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' } : {}) };
  // Only the names capabilities.remote lists: the laptop’s environment never crosses.
  const env = Object.fromEntries(Object.entries(set).filter(([k]) => CLAUDE_CODE_CAPABILITIES.remote.env.includes(k)));
  const spawnImpl = /** @type {typeof import('node:child_process').spawn} */ (
    /** @type {unknown} */ (
      remoteSpawn({
        connection: remote.link,
        harness: 'claude-code',
        folder,
        stdin: 'file',
        env,
        files: [],
        attachments: startAttachments(remote),
        ...(welcome?.claudeChecks === true ? { claudeCheck: { denyPrompts: !!remote.settings?.denyPrompts } } : {}),
        turn,
        ...(attach ? { attach: { from: 0 } } : {}),
      })
    )
  );
  return { turn, server, spawnImpl };
}

/**
 * What a remote turn said went wrong, to look for a missing session in: a host’s stderr stays in its err.log, but the
 * result says it too (recorded, claude 2.1.308: tests/fixtures/claude-code/resume-missing.jsonl).
 * @param {string} stderr @param {any} result  the mapper’s
 */
export const remoteSaid = (stderr, result) => `${stderr}\n${(Array.isArray(result?.errors) ? result.errors : []).join('\n')}`;
