// Runs a gh command the person confirmed (#852). It runs as an argument array, never through a shell, in a new empty
// folder so no repository config or hook there can change what it does, with only the environment gh needs (and git
// told to find no repository and read no config, as push-on-request.mjs’s cleanGit does), stdin holding only the
// body Postbox checked, or nothing, and a timeout. What it printed comes back without terminal codes, and cut.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The variables passed through from Postbox’s environment, when set: where gh is, and the person’s gh sign-in. */
const PASSED = ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** The person’s gh config folder, as gh finds it and as cleanGit passes it (push-on-request.mjs). */
export const ghConfigDir = (env = process.env) => env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'gh');

/** Set for every run: no prompts, colors, pagers, editors or browsers, so gh only does what the command says. */
const FIXED = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GH_EDITOR: 'false',
  EDITOR: 'false',
  VISUAL: 'false',
  BROWSER: 'false',
};

/** How much of what gh printed comes back. */
const OUTPUT_LIMIT = 4000;

/**
 * The environment a confirmed gh runs with, in its empty folder `cwd`: the passed-through variables that are set, its
 * config folder, git told to find no repository and read no config (critic’s read of r3, P2 3), and the fixed ones.
 * Nothing else, so no POSTBOX_ variable or SSH agent reaches it.
 * @param {Record<string, string | undefined>} env @param {string} cwd
 * @returns {Record<string, string>}
 */
export function ghEnv(env, cwd) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of PASSED) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  const git = {
    GIT_DIR: join(cwd, 'no-repository'),
    GIT_CEILING_DIRECTORIES: dirname(cwd),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  return { ...out, GH_CONFIG_DIR: ghConfigDir(env), ...git, ...FIXED };
}

/**
 * Whether gh’s config could send this call somewhere else, read just before it runs (critic’s read of r3, P2 2): a
 * `http_unix_socket`, a host other than github.com, or an alias named pr or issue. A file that can’t be read is as if
 * absent; one gh reads is in YAML, read here line by line, so a shape this reader doesn’t follow refuses.
 * @param {string} dir  gh’s config folder
 * @returns {Promise<string | null>}  why it can’t run, or null
 */
export async function ghConfigProblem(dir) {
  const config = await readFile(join(dir, 'config.yml'), 'utf8').catch(() => '');
  const hosts = await readFile(join(dir, 'hosts.yml'), 'utf8').catch(() => '');
  if (/^[ \t]*http_unix_socket:[ \t]*['"]?[^\s'"#]/m.test(config)) return 'gh’s config sends its calls through a socket (http_unix_socket)';
  const aliases = /^aliases:\s*\n((?:[ \t]+.*\n?)*)/m.exec(config)?.[1] ?? '';
  if (/^[ \t]+['"]?(pr|issue)['"]?:/m.test(aliases)) return 'gh’s config has an alias named pr or issue';
  const named = [...hosts.matchAll(/^(['"]?)([^\s:'"#][^:'"]*)\1:/gm)].map((m) => m[2]);
  if (named.some((h) => h !== 'github.com')) return `gh is signed in to ${named.find((h) => h !== 'github.com')}, not only github.com`;
  return null;
}

// CSI (ESC [ parameters, intermediates, a final letter), and OSC (ESC ], ended by BEL or ESC \).
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are exactly what this removes
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// C0 and C1 control characters, except tab and newline.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this removes
const CONTROLS = /[\x00-\x08\x0b-\x1f\x80-\x9f]/g;

/**
 * What gh printed, as text that can be shown: terminal escape sequences, then other control characters except tab and
 * newline, removed, then cut to 4,000 characters, with “…” where it was cut.
 * @param {string} text
 */
export function cleanOutput(text) {
  const clean = String(text).replace(ESCAPES, '').replace(CONTROLS, '');
  if (clean.length <= OUTPUT_LIMIT) return clean;
  return `${clean.slice(0, OUTPUT_LIMIT)}…`;
}

/**
 * Runs gh with this argument array, once the person has confirmed it: POSTBOX_GH_BIN, else gh on the PATH, unless
 * `bin` names one.
 * @param {string[]} argv
 * `input` is what gh reads on stdin: the body Postbox checked, given as `--body-file -` (critic’s read of r3, P1).
 * @param {{ bin?: string, timeoutMs?: number, input?: string }} [options]
 * @returns {Promise<{ status: number, output: string, argv: string[], timedOut: boolean }>}
 */
export async function runConfirmedGh(argv, { bin, timeoutMs = 30000, input } = {}) {
  const args = [...argv];
  const file = bin ?? process.env.POSTBOX_GH_BIN ?? 'gh';
  const cwd = await mkdtemp(join(tmpdir(), 'pb-confirm-gh-'));
  try {
    const { status, stdout, stderr, timedOut } = await run(file, args, { cwd, env: ghEnv(process.env, cwd), timeoutMs, input });
    const output = [stdout, stderr].filter((part) => part !== '').join('\n');
    return { status, output: cleanOutput(output), argv: args, timedOut };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Starts the process with execFile, with no shell, and resolves when it ends, killed or not.
 * @param {string} file @param {string[]} args @param {{ cwd: string, env: Record<string, string>, timeoutMs: number, input?: string }} how
 * @returns {Promise<{ status: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
function run(file, args, { cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env, shell: false, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ status: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false });
        return;
      }
      // execFile kills on its timeout, and on output past maxBuffer, which has a code of its own.
      const timedOut = err.killed === true && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const status = typeof err.code === 'number' && err.code !== 0 ? err.code : 1;
      resolve({ status, stdout: String(stdout ?? ''), stderr: String(stderr || err.message), timedOut });
    });
    // Only the checked body, if any, then closed, so gh can’t wait on the person.
    child.stdin?.end(input ?? undefined);
  });
}
