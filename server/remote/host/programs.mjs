// Finding the programs a host runs (#120, the design’s “The daemon”, “Finding programs”): node for the runners, and
// each harness’s CLI. A configured path (hello.settings’ nodePath, claudePath, kiroPath, codexPath) is used as given,
// and only it; otherwise the daemon looks on its PATH, then in the folders each CLI’s documented installers use, since
// `ssh host command` runs a non-interactive shell that often doesn’t read the profile that puts them on PATH.
//
// Where each installer puts its program, as documented:
// - Claude Code’s native installer “manages the launcher at `~/.local/bin/claude`” (code.claude.com/docs/en/setup,
//   “Auto-updates”). Its npm package (`npm install -g @anthropic-ai/claude-code`, same page) lands in npm’s global
//   prefix: ~/.npm-global/bin is the per-user prefix npm’s own docs suggest (docs.npmjs.com, “Resolving EACCES
//   permissions errors when installing packages globally”), and nvm’s and mise’s prefixes are each Node version’s bin
//   folder. Older releases’ local install was ~/.claude/local/claude. apt, dnf and apk put it in /usr/bin (same page),
//   and Homebrew on Linux in /home/linuxbrew/.linuxbrew/bin.
// - Kiro CLI’s installer (`curl -fsSL https://cli.kiro.dev/install | bash`) sets LINUX_INSTALL_DIR="$HOME/.local/bin".
// - Codex’s installer (`curl -fsSL https://chatgpt.com/codex/install.sh | sh`, github.com/openai/codex) uses
//   BIN_DIR="${CODEX_INSTALL_DIR:-$HOME/.local/bin}"; `npm install -g @openai/codex` uses npm’s prefix as above, and
//   a build from source with cargo, ~/.cargo/bin.
//
// Each program found is asked `--version` (an argument array, never a shell, with a time limit), and the version is
// reported, so the laptop can refuse a `claude` older than its MCP timeout behavior needs (the plan’s C3).

import { execFile as nodeExecFile } from 'node:child_process';
import { constants, promises as fsp } from 'node:fs';
import { checkHostPath } from '../../../shared/remote-settings.mjs';

/** The oldest Node a runner runs on (the design’s “Finding programs”). */
export const NODE_MAJOR = 22;
/** How long `--version` may take. A CLI’s first run can unpack itself, so it’s generous. */
export const VERSION_TIMEOUT_MS = 10_000;
/** welcome.harnesses[].looked holds at most this many (REMOTE_LIMITS.looked). */
const LOOKED_MAX = 32;

/** Each harness’s program name and the setting that names its path. */
export const HARNESS_PROGRAMS = Object.freeze({
  'claude-code': { program: 'claude', setting: 'claudePath' },
  'kiro-cli': { program: 'kiro-cli', setting: 'kiroPath' },
  codex: { program: 'codex', setting: 'codexPath' },
});

/**
 * @typedef {{ name: string, path: string | null, version: string | null, looked: string[] }} HarnessFound
 * @typedef {{ code: string, message: string }} Problem
 * @typedef {{ node: { path: string, version: string }, harnesses: HarnessFound[], problems: Problem[] }} Programs
 * @typedef {(file: string, args: string[], opts: { timeout: number, maxBuffer: number, env?: NodeJS.ProcessEnv },
 *   cb: (err: Error | null, stdout: string, stderr: string) => void) => unknown} ExecFile
 */

/**
 * The folders to look in for a harness, in order: the daemon’s PATH, then the documented install folders.
 * @param {string} home @param {string | undefined} pathVar @param {(dir: string) => Promise<string[]>} listDir
 */
export async function searchFolders(home, pathVar, listDir) {
  const h = home === '/' ? '' : home;
  /** Each Node version’s bin folder under a version manager, newest first. @param {string} dir @param {string} [sub] */
  const versions = async (dir, sub = 'bin') => {
    const names = await listDir(dir).catch(() => []);
    return names
      .filter((n) => /^v?\d+(\.\d+)*$/.test(n))
      .sort((a, b) => compareVersions(b, a))
      .map((n) => `${dir}/${n}/${sub}`);
  };
  const dirs = [
    ...(pathVar ?? '').split(':').filter((d) => d.startsWith('/')),
    `${h}/.local/bin`,
    `${h}/.npm-global/bin`,
    `${h}/.claude/local`,
    ...(await versions(`${h}/.nvm/versions/node`)),
    ...(await versions(`${h}/.local/share/mise/installs/node`)),
    `${h}/.volta/bin`,
    `${h}/.cargo/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ];
  return [...new Set(dirs.map((d) => d.replace(/\/+$/, '')).filter((d) => d && checkHostPath(d, 'folder').ok))];
}

/** Compares dotted versions, numerically, ignoring a leading v. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * A version from `--version`’s output: the first x.y.z in it (claude prints “2.1.211 (Claude Code)”), else its first
 * line, clipped; null for no output.
 * @param {string} out
 */
export function parseVersion(out) {
  const m = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(out);
  if (m) return m[0].slice(0, 200);
  const first = out.split('\n').find((l) => l.trim());
  return first ? first.trim().slice(0, 200) : null;
}

/**
 * Finds node and the harnesses.
 * @param {{ home: string, settings: Record<string, any>, env?: NodeJS.ProcessEnv, execFile?: ExecFile,
 *   isExecutable?: (path: string) => Promise<boolean>, listDir?: (dir: string) => Promise<string[]>,
 *   execPath?: string, nodeVersion?: string }} opts
 *   execPath and nodeVersion: the Node running the daemon, which runs the runners unless nodePath says otherwise.
 * @returns {Promise<Programs>}
 */
export async function findPrograms({
  home,
  settings,
  env = process.env,
  execFile = /** @type {ExecFile} */ (/** @type {unknown} */ (nodeExecFile)),
  isExecutable = defaultIsExecutable,
  listDir = (dir) => fsp.readdir(dir),
  execPath = process.execPath,
  nodeVersion = process.version,
}) {
  /** @type {Problem[]} */
  const problems = [];
  const version = (path) =>
    new Promise((resolve) => {
      try {
        execFile(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, env }, (err, stdout) =>
          resolve(err ? { error: err.message } : { version: parseVersion(String(stdout)) }),
        );
      } catch (e) {
        resolve({ error: e.message });
      }
    });

  // Node: the configured one, else the one running this daemon.
  let node = { path: execPath, version: nodeVersion };
  if (settings.nodePath) {
    const r = /** @type {{ version?: string | null, error?: string }} */ (
      (await isExecutable(settings.nodePath)) ? await version(settings.nodePath) : { error: 'it isn’t an executable file' }
    );
    if (r.version) node = { path: settings.nodePath, version: r.version };
    else
      problems.push({
        code: 'no-node',
        message: `The node at ${settings.nodePath} (nodePath) can’t run: ${r.error ?? 'it printed no version'}. Using ${execPath}.`,
      });
  }
  const major = Number(/^v?(\d+)/.exec(node.version)?.[1] ?? 0);
  if (major < NODE_MAJOR)
    problems.push({
      code: 'old-node',
      message: `Node ${node.version} at ${node.path} is older than ${NODE_MAJOR}, which Postbox’s runners need. Install Node ${NODE_MAJOR} or later, or set nodePath.`,
    });

  const folders = await searchFolders(home, env.PATH, listDir);
  const harnesses = await Promise.all(
    Object.entries(HARNESS_PROGRAMS).map(async ([name, { program, setting }]) => {
      const configured = settings[setting];
      const candidates = configured ? [configured] : folders.map((d) => `${d}/${program}`);
      /** @type {string[]} */
      const looked = [];
      for (const path of candidates) {
        if (looked.length < LOOKED_MAX) looked.push(path);
        if (!(await isExecutable(path))) continue;
        const r = /** @type {{ version?: string | null, error?: string }} */ (await version(path));
        if (r.error) problems.push({ code: 'version-failed', message: `${path} --version failed: ${r.error.slice(0, 500)}` });
        return { name, path, version: r.version ?? null, looked };
      }
      if (configured) problems.push({ code: 'not-found', message: `${configured} (${setting}) isn’t an executable file on this host.` });
      return { name, path: null, version: null, looked };
    }),
  );
  return { node, harnesses, problems: problems.slice(0, 32) };
}

/** A regular file this user may run. @param {string} path */
async function defaultIsExecutable(path) {
  try {
    const st = await fsp.stat(path);
    if (!st.isFile()) return false;
    await fsp.access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
