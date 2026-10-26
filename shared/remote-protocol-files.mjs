// The host’s files (shared/remote-protocol.mjs): the paths of one version’s code and of a turn’s folder, and the
// checks on the records a turn’s folder holds (start.json, runner.json, exit.json).

import { BOOT_ID_RE, clip, fields, hostPath, int, oneOf, run, TURN_RE, turnId, utf8Bytes, VERSION_RE } from './remote-protocol-checks.mjs';
import { HARNESSES, REMOTE_DIR, SOCKET_PATH_BYTES, STDIN_KINDS } from './remote-protocol-constants.mjs';
import { checkArgv, checkEnv, checkExit } from './remote-protocol-parts.mjs';

/** @template T @typedef {import('./remote-protocol-checks.mjs').Result<T>} Result */

/**
 * The host’s paths for one version of the code. Built from `welcome.home` on the laptop and from the home folder on
 * the host, so both agree.
 * @param {string} home  the host user’s home folder, absolute
 * @param {string} version  Postbox’s package version
 */
export function hostPaths(home, version) {
  const h = hostPath(home, 'home');
  if (h) throw new TypeError(h);
  if (!VERSION_RE.test(version) || version.includes('..')) throw new TypeError(`“${clip(version)}” isn’t a version Postbox installs, such as 0.10.0.`);
  const root = `${home === '/' ? '' : home}/${REMOTE_DIR}`;
  const code = `${root}/${version}`;
  const hostDir = `${code}/server/remote/host`;
  return {
    root,
    code,
    /** The program `ssh` runs: `<host> attach`. */
    host: `${hostDir}/host`,
    shim: `${hostDir}/shim.mjs`,
    runner: `${hostDir}/runner.mjs`,
    socket: `${code}/daemon.sock`,
    /**
     * The version’s start lock, a folder made with mkdir: an attach holds it while it starts `host serve`, and the
     * installer while it checks and replaces the version’s folder. It’s outside that folder, which the installer renames.
     */
    lock: `${root}/locks/${version}.lock`,
    token: `${root}/token`,
    turns: `${root}/turns`,
    /** @param {string} turn @param {string} [file]  one of TURN_FILES’ values, MESSAGE_FILE, or `${ATTACHMENTS_DIR}/<name>` */
    turn(turn, file) {
      if (!TURN_RE.test(turn)) throw new TypeError(`“${clip(turn)}” isn’t a turn ID.`);
      return `${root}/turns/${turn}${file ? `/${file}` : ''}`;
    },
  };
}

/** Whether a Unix socket can be bound at this path on Linux. @param {string} path */
export const socketPathFits = (path) => utf8Bytes(path) <= SOCKET_PATH_BYTES;

/**
 * exit.json: how the harness ended. Node gives a code or a signal, never both; `at` is milliseconds since the epoch.
 * @typedef {{ code: number | null, signal: string | null, at: number }} ExitRecord
 */
/**
 * runner.json: the runner’s identity. The daemon signals its process group only when the PID, the boot ID
 * (/proc/sys/kernel/random/boot_id) and the start time (/proc/<pid>/stat field 22, in clock ticks since boot) all still
 * match (the design’s “The daemon”). The runner leads its own session and group, so the group is -pid.
 * @typedef {{ turn: string, version: string, pid: number, bootId: string, startTime: number }} RunnerRecord
 */

/**
 * start.json: what the daemon tells a runner to start. The daemon launches the runner as
 * `<node> <hostPaths().runner> <turn>`, detached, with no stdio of its own; the runner reads this file, never its
 * arguments, for the rest. `program` is the absolute path of the harness the daemon found (or the configured one);
 * `argv`, `env`, `stdin` and `folder` are the `start` message’s, unchanged.
 * @typedef {{ turn: string, harness: string, program: string, argv: string[], env: Record<string, string>,
 *   stdin: 'file' | 'none' | 'held', folder: string }} StartRecord
 */

/** @param {unknown} v @returns {Result<StartRecord>} */
export function validateStartRecord(v) {
  return run('start.json', v, () => {
    const m = /** @type {any} */ (v);
    return (
      fields(m, 'start.json', ['turn', 'harness', 'program', 'argv', 'env', 'stdin', 'folder']) ||
      turnId(m.turn, 'start.json.turn') ||
      oneOf(m.harness, 'start.json.harness', HARNESSES) ||
      hostPath(m.program, 'start.json.program') ||
      checkArgv(m.argv) ||
      checkEnv(m.env) ||
      oneOf(m.stdin, 'start.json.stdin', STDIN_KINDS) ||
      hostPath(m.folder, 'start.json.folder')
    );
  });
}

/** @param {unknown} v @returns {Result<ExitRecord>} */
export function validateExitRecord(v) {
  return run('exit.json', v, () => checkExit(v, 'exit.json'));
}

/** @param {unknown} v @returns {Result<RunnerRecord>} */
export function validateRunnerRecord(v) {
  return run('runner.json', v, () => {
    const m = /** @type {any} */ (v);
    return (
      fields(m, 'runner.json', ['turn', 'version', 'pid', 'bootId', 'startTime']) ||
      turnId(m.turn, 'runner.json.turn') ||
      (VERSION_RE.test(m.version) ? '' : `runner.json.version must be a version such as 0.10.0.`) ||
      int(m.pid, 'runner.json.pid', 2, 2 ** 31) ||
      (typeof m.bootId === 'string' && BOOT_ID_RE.test(m.bootId) ? '' : 'runner.json.bootId must be the boot ID, a lowercase UUID.') ||
      int(m.startTime, 'runner.json.startTime', 0, Number.MAX_SAFE_INTEGER)
    );
  });
}
