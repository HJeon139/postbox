// Installing Postbox’s host code on a remote host (#120, architecture.md “Remote hosts”, “The daemon” and “Security”),
// from the laptop, over Postbox’s own ssh (ssh.mjs’s options: BatchMode, no shared connection, no agent forwarding).
//
// What ships: every file under server/remote/host/ and, transitively, every file they import (only node: modules and
// shared/, which tests/host-imports.test.mjs checks through install-bundle.mjs’s hostFiles), plus a package.json with
// this Postbox’s version. They keep the repo’s layout under ~/.postbox-remote/<version>/, so relative imports work
// unchanged, beside manifest.sha256, each file’s SHA-256 in sha256sum’s format.
//
// How, in two ssh runs, each with a fixed remote command built only from the validated version (as remoteCommand
// builds attach’s), never a shell string on the laptop:
// 1. installCommand: `/bin/sh -c '<script>' postbox-install <version>`. With umask 077, the script makes
//    ~/.postbox-remote (0700), unpacks the tar stream on its stdin into a temporary folder beside the version’s, checks
//    every file against the manifest (sha256sum, else shasum -a 256, else a few lines of node), and renames the folder
//    into place, which is atomic. The same version that’s there is left alone (apart from node-path) only when its
//    manifest is this one, byte for byte, and its files pass the same check; other code under that version is
//    replaced, renamed aside and removed, holding the version’s start lock, unless a daemon or turn of that version is
//    running or an attach is starting its daemon (so stale code doesn’t keep running under an unchanged version, as in
//    a build where every change is still 0.10.0). It prints `installed <version>` or `present <version>`.
// 2. tokenCommand: `<the version’s host> token`, the launcher (server/remote/host/host), which finds a Node 22 or later
//    and has the daemon’s code make ~/.postbox-remote/token (0600) if it’s missing and print it. So a host without a
//    usable node is found at install, with the launcher’s message saying where it looked.
// The script is one line in single quotes because sshd hands the command to the person’s login shell, which may not
// be a POSIX one: it has no single quote, no “\\” or “\'” (fish’s escapes inside single quotes), no “!” (csh’s history)
// and no new line, which tests check.
//
// node-path: the host’s nodePath setting, if it has one, goes in the tar as node-path, beside the manifest rather than
// in it, since it’s the host’s setting and not code: a reinstall of a present version replaces it (or removes it, once
// the setting is cleared), and the launcher checks what it names before using it.
//
// The tar is written by install-bundle.mjs, a minimal ustar writer, rather than by the system’s tar: macOS’s bsdtar
// adds extended attributes and AppleDouble entries that GNU tar on the host warns about, and records the laptop’s user
// and group names. This one is the same bytes on any laptop, names no user, and sets each file’s mode (0700 for the
// launcher, else 0600). The host unpacks it with its own tar, which as an ordinary user doesn’t restore ownership.
//
// The laptop’s copy of the token lives in its own file under Postbox’s data folder, `<data>/remote-tokens/<host id>`
// (0600, in a 0700 folder), never in the store or the state the page reads; ssh.mjs sends it in hello, on stdin.
//
// The first install writes outside the repo on both machines, so the UI confirms it first (L6), worded from
// describeInstall.
//
// This module runs the install and words it; its parts are beside it: install-bundle.mjs (what ships),
// install-script.mjs (the remote commands) and install-token.mjs (the laptop’s copy of the token).

import { spawn as nodeSpawn } from 'node:child_process';
import { REMOTE_DIR } from '../../shared/remote-protocol.mjs';
import { bundle, checkVersion, hostFiles, ROOT } from './install-bundle.mjs';
import { installArgs, installCommand, tokenCommand } from './install-script.mjs';
import { storeToken, TOKEN_RE, tokenFile } from './install-token.mjs';
import { classifyExit, failure, SshFailure } from './ssh.mjs';

export { bundle, hostFiles, MANIFEST, NODE_PATH_FILE, ROOT, ustar } from './install-bundle.mjs';
export { INSTALL_SCRIPT, installArgs, installCommand, tokenCommand } from './install-script.mjs';
export { forgetToken, readToken, TOKEN_RE, TOKENS_DIR, tokenFile } from './install-token.mjs';

/** How long one install run may take before its ssh is stopped. */
export const INSTALL_TIMEOUT = 5 * 60 * 1000;
/** How long the token run may take. */
export const TOKEN_TIMEOUT = 2 * 60 * 1000;
/**
 * The script’s exit codes (sysexits.h), each with what the person is told. 75 (a different build of the version is
 * running, or an attach is starting its daemon) is worded in installOutcome, which names the version.
 */
const SCRIPT_EXITS = Object.freeze({
  65: 'the files didn’t arrive whole (the host’s tar couldn’t unpack them)',
  66: 'a file’s SHA-256 on the host didn’t match the manifest',
  69: 'the host has no sha256sum, shasum or node to check the files with',
  77: `~/${REMOTE_DIR}, or the version’s folder or locks folder there, is a symbolic link, and Postbox installs only into real folders`,
  78: 'the home folder (HOME) on the host isn’t an absolute path',
});

// ── Installing ──────────────────────────────────────────────────────────────────────

/**
 * Runs ssh once: `input` on its stdin, then stdout and stderr when it exits.
 * @param {{ spawn: import('./ssh.mjs').SpawnLike, program: string, args: string[], input: Buffer | null, timeout: number,
 *   destination: string, setTimer: (fn: () => void, ms: number) => any, clearTimer: (t: any) => void }} o
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>}
 */
function run({ spawn, program, args, input, timeout, destination, setTimer, clearTimer }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(failure('failed', destination, { why: `Postbox couldn’t start ssh: ${e.message}` }));
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    const finish = (/** @type {() => void} */ settle) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      settle();
    };
    child.stdout.on('data', (b) => out.push(Buffer.from(b)));
    child.stderr.on('data', (b) => err.push(Buffer.from(b)));
    child.stdin.on('error', () => {}); // ssh exited before reading it all; its exit says why
    child.on('error', (e) =>
      finish(() =>
        reject(
          failure('failed', destination, {
            why: e.code === 'ENOENT' ? `ssh isn’t installed or isn’t on PATH (${program}).` : `Postbox couldn’t start ssh: ${e.message}`,
          }),
        ),
      ),
    );
    child.on('close', (code, signal) =>
      finish(() => {
        if (timedOut) reject(failure('unreachable', destination, { why: `The host didn’t finish within ${Math.round(timeout / 1000)} seconds.` }));
        else resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      }),
    );
    child.stdin.end(input ?? undefined);
  });
}

/** The last line of a text that says something. @param {string} text */
const lastLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * A protocol `error` line on stdout (the launcher’s, or the daemon’s main), if there is one.
 * @param {string} stdout @returns {{ code: string, message: string } | null}
 */
function errorLine(stdout) {
  for (const line of stdout.split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m?.type === 'error' && typeof m.message === 'string') return { code: String(m.code), message: m.message };
    } catch {}
  }
  return null;
}

/**
 * The install run’s outcome: whether it installed, or found the version there, else an SshFailure.
 * @param {string} d  the destination @param {string} version @param {{ code: number | null, signal: string | null, stdout: string, stderr: string }} r
 * @returns {boolean} installed
 */
export function installOutcome(d, version, r) {
  if (r.code === 255) throw classifyExit({ destination: d, code: r.code, signal: r.signal, stderr: r.stderr });
  const said = lastLine(r.stdout);
  if (r.code === 0 && said === `installed ${version}`) return true;
  if (r.code === 0 && said === `present ${version}`) return false;
  const known = r.code !== null ? SCRIPT_EXITS[/** @type {keyof typeof SCRIPT_EXITS} */ (r.code)] : undefined;
  const stderr = r.stderr.replace(/\r\n?/g, '\n');
  const quote = lastLine(stderr.replace(/^postbox install: .*$/gm, '')) || lastLine(stderr);
  // 75 from starting(), not busy(): an attach holds the version’s start lock, so it’s worth trying again soon.
  const starting = r.code === 75 && /^postbox install: Postbox \S+ is starting on this host/m.test(stderr);
  const why =
    r.code === 75
      ? `Postbox ${version} is ${starting ? 'starting' : 'running'} on ${d} with different code`
      : known
        ? `${known}${r.code === 66 && quote ? ` (${quote})` : ''}`
        : r.code === 0
          ? `the host answered “${said.slice(0, 200)}” instead of saying it installed`
          : `the install ended with ${r.signal ?? `exit status ${r.code}`}${quote ? `: “${quote.slice(0, 300)}”` : ''}`;
  const where = `~/${REMOTE_DIR}/${version}`;
  const next = starting
    ? `Install again in a moment. If Postbox then says it’s running on ${d}, stop its turns there first.`
    : r.code === 75
      ? `Stop its turns on ${d}, then install again. Its daemon exits on its own once no turn runs and Postbox isn’t attached for the host’s idle time.`
      : r.code === 77
        ? `On ${d}, replace the symbolic link at ~/${REMOTE_DIR}, ${where} or ~/${REMOTE_DIR}/locks with a folder of your own, then install again.`
        : r.code === 69
          ? `Install coreutils (for sha256sum) or Node 22 or later on ${d}, then install again.`
          : `Install again. If it fails the same way, run \`ssh ${d}\` in a terminal and check that ~/${REMOTE_DIR} can be written and the disk isn’t full.`;
  throw new SshFailure('failed', `Postbox couldn’t install its host program on ${d}: ${why}.`, next, {
    code: r.code,
    signal: r.signal,
    stderr,
  });
}

/**
 * The token run’s outcome: the token, else an SshFailure.
 * @param {string} d @param {{ code: number | null, signal: string | null, stdout: string, stderr: string }} r
 * @returns {string}
 */
export function tokenOutcome(d, r) {
  if (r.code === 255) throw classifyExit({ destination: d, code: r.code, signal: r.signal, stderr: r.stderr });
  const detail = { code: r.code, signal: r.signal, stderr: r.stderr };
  const refused = errorLine(r.stdout);
  if (refused)
    throw new SshFailure(
      refused.code === 'no-node' ? 'no-node' : 'failed',
      `Postbox installed its files on ${d}, but its host program couldn’t start there. It said: “${refused.message}”`,
      refused.code === 'no-node'
        ? `Install Node 22 or later on ${d}, or set its Node path in Postbox’s host settings, then install again.`
        : 'Fix that on the host, then install again.',
      detail,
    );
  if (r.code === 127 || r.code === 126) throw classifyExit({ destination: d, code: r.code, signal: r.signal, stderr: r.stderr });
  const token = lastLine(r.stdout);
  if (r.code === 0 && TOKEN_RE.test(token)) return token;
  throw new SshFailure(
    'failed',
    `Postbox installed its files on ${d}, but didn’t get the daemon’s token back${r.code ? ` (exit status ${r.code})` : ''}.${lastLine(r.stderr) ? ` The host said: “${lastLine(r.stderr).slice(0, 300)}”` : ''}`,
    `Install again. If it fails the same way, check ~/${REMOTE_DIR}/token on ${d}: it should be a file of yours, holding one line.`,
    detail,
  );
}

/**
 * Installs this Postbox’s host code on a host and gets its daemon’s token, which it keeps on the laptop.
 * @param {{ host: { id: string, name: string, settings: import('../../shared/remote-settings.mjs').HostSettings },
 *   version: string, dataDir: string, spawn?: import('./ssh.mjs').SpawnLike, program?: string, root?: string,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, installTimeout?: number,
 *   tokenTimeout?: number, mtime?: number }} o
 *   host: as the runtime keeps it (its name is the ssh destination). version: Postbox’s package version. dataDir: the
 *   data folder server/index.mjs uses (`data/` by default). spawn and program run ssh; the rest are for tests.
 * @returns {Promise<{ token: string, installed: boolean, version: string }>} installed: false when the version was there
 * @throws {SshFailure} with a message and the next step, or a TypeError for an invalid host, version or nodePath
 */
export async function installHost({
  host,
  version,
  dataDir,
  spawn = /** @type {import('./ssh.mjs').SpawnLike} */ (/** @type {unknown} */ (nodeSpawn)),
  program = 'ssh',
  root = ROOT,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer = (t) => clearTimeout(t),
  installTimeout = INSTALL_TIMEOUT,
  tokenTimeout = TOKEN_TIMEOUT,
  mtime,
}) {
  const file = tokenFile(dataDir, host?.id);
  const install = installArgs(host, version, installCommand(version));
  const token = installArgs(host, version, tokenCommand(version));
  const { tar } = bundle({ version, nodePath: host.settings?.nodePath ?? null, root, mtime });
  const d = host.name;
  const common = { spawn, program, destination: d, setTimer, clearTimer };
  const installed = installOutcome(d, version, await run({ ...common, args: install, input: tar, timeout: installTimeout }));
  const got = tokenOutcome(d, await run({ ...common, args: token, input: null, timeout: tokenTimeout }));
  await storeToken(file, got);
  return { token: got, installed, version };
}

// ── The confirm ─────────────────────────────────────────────────────────────────────

/**
 * What an install does, for the confirm the UI shows before the first one (L6): the paths it writes on each machine
 * and the steps, in words, and the command lines ssh runs.
 * @param {{ id: string, name: string, settings: import('../../shared/remote-settings.mjs').HostSettings }} host
 * @param {{ version: string, dataDir: string, root?: string }} o
 */
export function describeInstall(host, { version, dataDir, root = ROOT }) {
  checkVersion(version);
  const d = host.name;
  const code = `~/${REMOTE_DIR}/${version}`;
  const tokenOnHost = `~/${REMOTE_DIR}/token`;
  const tokenHere = tokenFile(dataDir, host.id);
  const nodePath = host.settings?.nodePath ?? null;
  const { files } = hostFiles(root);
  const count = files.length + 1; // and package.json
  const steps = [
    `Connect to ${d} with your ssh, as your user there, without asking for a password or a new host key.`,
    `Copy ${count} files of Postbox’s host program to ${code}/ on ${d}, readable only by you (folders 0700, files 0600), and check each one’s SHA-256. A copy of ${version} that’s already there is left as it is if its files are these; if they differ, it’s replaced, unless it’s running.`,
    nodePath
      ? `Write ${code}/node-path on ${d}, naming the Node it runs with: ${nodePath}.`
      : `Find Node 22 or later on ${d}: on PATH, else under ~/.nvm, ~/.local/share/mise, ~/.volta, /usr/local/bin or /usr/bin.`,
    `Make the daemon’s token at ${tokenOnHost} on ${d} (0600) if it isn’t there, and keep a copy on this computer at ${tokenHere} (0600), outside what the page reads.`,
  ];
  return {
    destination: d,
    version,
    host: { root: `~/${REMOTE_DIR}`, code, token: tokenOnHost, nodePath: nodePath ? `${code}/node-path` : null },
    laptop: { token: tokenHere },
    steps,
    commands: [installCommand(version), tokenCommand(version)],
    text: `Install Postbox’s host program on ${d}? This writes outside Postbox’s folder on both computers:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nNothing runs as root, and nothing outside ~/${REMOTE_DIR} changes on ${d}.`,
  };
}
