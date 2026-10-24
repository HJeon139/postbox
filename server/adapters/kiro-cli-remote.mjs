// The Kiro CLI backend on a remote host (#120, ctx.remote; architecture.md “Remote hosts”): the turn runs through the
// host’s daemon (server/remote/process.mjs’s remoteSpawn), and the arguments are the same but for where things are:
// - The agent file goes in `start.agentFile` (its name and text), which the daemon writes into the agents folder of
//   the Kiro home the runner will use and removes when the turn ends: with your setup, the host’s own (its KIRO_HOME,
//   else ~/.kiro), which only the daemon knows; for an Isolated persona a Kiro home of Postbox’s own,
//   `~/.postbox-remote/kiro-home/<handle>`, with KIRO_HOME set to it (the one variable that crosses). Postbox’s server
//   in it is the host’s stdio shim, run by the daemon’s node, never the laptop’s MCP URL.
// - The host turn is the runtime’s, ctx.remote.turn; the fresh start after a missing session is a second one, from
//   ctx.remote.nextTurn(). The shim’s path is under ctx.remote.version, the Postbox code installed there.
// - The working folder is ctx.remote.folder, and it’s the only folder the read and write rules name: the project’s
//   folder and the extra folders are laptop paths, which mean nothing on the host, so they don’t cross. Kiro matches
//   resolved paths, and a host path can’t be resolved from here, so it’s named as given.
// - The message is still the last argument. Linux limits one argument to 128 KiB (MAX_ARG_STRLEN, 32 pages of 4 KiB;
//   execve(2)), so a longer one is refused before the turn starts. And other users on the host can read a process’s
//   arguments in /proc/<pid>/cmdline unless /proc is mounted with hidepid (proc(5)), so each remote turn says so, as a
//   step in its activity.
// - Stop goes through stopTurn’s remote branch: the daemon’s `stop`, never a local signal.
// server/adapters/kiro-cli.mjs runs the turn; this module holds what only a host needs.

import { REMOTE_DIR, REMOTE_LIMITS, utf8Bytes } from '../../shared/remote-protocol.mjs';
import { remoteSpawn } from '../remote/process.mjs';
import { hostShim } from './remote-turn.mjs';
import { setupOf } from './setup.mjs';

/**
 * How this backend runs on a remote host (KIRO_CAPABILITIES.remote, #117): nothing goes in on stdin, only KIRO_HOME
 * reaches the host (an Isolated persona’s own home), Postbox’s server is in the custom agent file, and its sign of work
 * is a tool call still in progress, since stdout is silent while a command runs. Its sign-in error isn’t recorded yet.
 */
export const KIRO_REMOTE = Object.freeze({ stdin: 'none', env: Object.freeze(['KIRO_HOME']), server: 'agent-file', work: 'open-tool-call', signInError: null });

/**
 * The variables that say which Kiro home a persona runs with on a remote host: none with your setup (the daemon finds
 * the host’s own, from its KIRO_HOME or ~/.kiro, and puts the agent file there), or KIRO_HOME set to one of Postbox’s
 * own per handle under ~/.postbox-remote when Isolated.
 * @param {any} persona @param {string} home  welcome.home
 * @returns {Record<string, string>}
 */
export function kiroRemoteEnv(persona, home) {
  if (setupOf(persona).usesHostSetup) return {};
  const handle = String(persona?.handle ?? '').replace(/[^a-z0-9_-]/gi, '') || 'agent';
  return { KIRO_HOME: `${home === '/' ? '' : home}/${REMOTE_DIR}/kiro-home/${handle}` };
}

/**
 * Refuses a message too long to be one argument on Linux, before a remote turn starts.
 * @param {string} prompt  the last argument, as it would go
 */
export function checkRemoteMessage(prompt) {
  const n = utf8Bytes(prompt);
  if (n <= REMOTE_LIMITS.argBytes) return;
  throw new Error(
    `This message is ${Math.ceil(n / 1024)} KiB, too long for Kiro CLI on a remote host: Kiro takes its message as one command-line argument, and Linux limits one argument to 128 KiB. Shorten it, or put the long part in a file in the agent’s folder on the host and point to it.`,
  );
}

/** The step a remote Kiro turn shows: its message is an argument, and arguments can be read on the host. */
export const REMOTE_ARGV_NOTE = Object.freeze({
  id: 'kiro-remote-argv',
  label: 'Other users on the host can read this message',
  state: 'done',
  detail:
    'Kiro CLI takes its message as a command-line argument, and other users on a Linux host can read a process’s arguments in /proc unless it’s mounted with hidepid. Don’t send a Kiro agent on a shared host anything they shouldn’t see.',
});

/**
 * The spawn that runs one turn on the host, as host turn `turn` (or reads it from the start, with `attach`). Before it,
 * a message too long for one argument is refused; after it, a new turn shows REMOTE_ARGV_NOTE.
 * @param {any} ctx  the turn’s, with ctx.remote
 * @param {{ agent: string, cwd: string, turn?: string, attach: boolean, prompt: string,
 *           agentText: (shim: { command: string, args: string[] }) => string }} o  agentText: the agent file, with the shim as Postbox’s server
 */
export function kiroRemoteSpawn(ctx, { agent, cwd, turn, attach, prompt, agentText }) {
  if (!attach) checkRemoteMessage(prompt);
  const { link, welcome } = ctx.remote;
  const hostTurn = /** @type {string} */ (turn);
  const text = agentText(hostShim(ctx.remote, welcome, hostTurn));
  // Only the names capabilities.remote lists cross; bin, cwd and the laptop’s env don’t (remoteSpawn ignores them).
  const allowed = new Set(KIRO_REMOTE.env);
  const remoteEnv = Object.fromEntries(Object.entries(kiroRemoteEnv(ctx.persona, welcome.home)).filter(([k]) => allowed.has(k)));
  const spawnFn = remoteSpawn({
    connection: link,
    harness: 'kiro-cli',
    folder: cwd,
    stdin: 'none',
    env: remoteEnv,
    agentFile: { name: `${agent}.json`, text },
    turn: hostTurn,
    ...(attach ? { attach: { from: 0 } } : {}),
  });
  if (!attach) ctx.activity({ ...REMOTE_ARGV_NOTE });
  return spawnFn;
}
