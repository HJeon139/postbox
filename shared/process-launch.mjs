// The shape of a background process’s launch (#1614, designs/architecture/background-processes.md, “The launcher”):
// the launcher’s arguments, and how Postbox reads them back from a command line in ps. tools/postbox-process.mjs and
// server/bg-identity.mjs both read this, so the line the launcher runs and the line Postbox looks for can’t drift.

/** A process’s id, as start_process makes it (server/ids.mjs): p_ and 8 letters or digits. */
export const PROCESS_ID = /^p_[A-Za-z0-9]{8}$/;

/** The option that marks the leader’s copy of the launcher. */
export const LEADER_FLAG = '--leader';

/** How long a launch waits for Postbox’s go-ahead before it exits, and nothing runs. */
export const LAUNCH_WAIT_MS = 30_000;

/**
 * Postbox’s go-ahead to a bound leader. Not SIGUSR1, which the design first named: Node starts its inspector on
 * SIGUSR1 while no listener is installed, and with --disable-sigusr1 a listener never hears it. A SIGUSR2 that
 * arrives before the leader listens ends the leader, so an early go-ahead runs nothing.
 */
export const GO_SIGNAL = 'SIGUSR2';

/**
 * The launcher’s arguments after its path: `run <id>`, its options, `--`, and the command as words.
 * @param {string} id @param {string[]} command @param {{ leader?: boolean }} [options]
 */
export const launchArgs = (id, command, { leader = false } = {}) => ['run', id, ...(leader ? [LEADER_FLAG] : []), '--', ...command];

/**
 * What a command line, as ps shows it, says of a launch by this launcher: the id after `<launcher> run `, and whether
 * it’s the leader’s copy. The first such run on the line is the launch: a command after it that names the launcher
 * again is only its command. Null for a line that doesn’t run the launcher.
 * @param {string} line @param {string} launcher  the launcher’s real path
 * @returns {{ id: string, leader: boolean } | null}
 */
export function launchOf(line, launcher) {
  const head = `${launcher} run `;
  const at = String(line).indexOf(head);
  if (at < 0 || (at > 0 && line[at - 1] !== ' ')) return null;
  const [id, next, after] = line.slice(at + head.length).split(' ');
  if (!PROCESS_ID.test(id ?? '')) return null;
  return { id, leader: next === LEADER_FLAG && after === '--' };
}
