// The runner’s own ssh to a host (#120), to check what Postbox can’t say about itself: what runs there, what listens,
// which turns are there, and whether ~/.postbox-remote is gone; and to break things on purpose (kill the daemon) and
// put P0’s launcher there. The ssh is an argument list, in BatchMode, with a fixed remote command, `sh -s`: each
// script is a constant fed on stdin, so the login shell parses nothing but that, whatever it is. The only value a
// script takes is a turn ID, checked as a UUID first, and the launcher’s two paths, checked as plain absolute paths.
// The parsers are pure, so tests feed them recorded output.

import { spawn as nodeSpawn } from 'node:child_process';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A path the launcher’s script may quote as it is: absolute, with nothing a shell or a quote would read. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/+@-]+$/;
// A pattern that matches what it names but not itself: “[.]postbox-remote” in pgrep’s own arguments isn’t “.postbox-remote”.
const ONE = '[.]postbox-remote';

/** The remote scripts, by what they check. Each prints only what its parser reads. */
export const SCRIPTS = {
  // Everything of Postbox’s running as this user: the daemon, its relays, the runners and the shims.
  processes: `pgrep -a -u "$(id -u)" -f '${ONE}' || true`,
  // TCP listeners, with their processes where ss can say, then this user’s processes and their sessions.
  listeners: `ss -ltnp 2>/dev/null || ss -ltn; echo '--ps--'; ps -u "$(id -u)" -o pid=,sid=,args=`,
  turns: `ls -1 "$HOME/.postbox-remote/turns" 2>/dev/null || true`,
  removed: `if [ -e "$HOME/.postbox-remote" ]; then echo present; else echo absent; fi`,
  killDaemon: `if pkill -KILL -u "$(id -u)" -f '${ONE}/[^ ]*/host[.]mjs serve'; then echo killed; else echo none; fi`,
  cleanUp: `rm -rf -- "$HOME/postbox-uat"; echo removed`,
  home: 'printf %s "$HOME"',
  // Node and Claude Code where a non-interactive shell finds them, then where their installers put them.
  programs: [
    'for n in "$(command -v node 2>/dev/null)" "$HOME"/.local/share/mise/installs/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/local/bin/node /usr/bin/node; do',
    '  if [ -n "$n" ] && [ -x "$n" ]; then echo "node $n"; fi',
    'done',
    'for c in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "$HOME/.claude/local/claude" /usr/local/bin/claude /usr/bin/claude; do',
    '  if [ -n "$c" ] && [ -x "$c" ]; then echo "claude $c"; fi',
    'done',
  ].join('\n'),
};

/**
 * Makes the project’s folder for this run on the host, ~/postbox-uat/<run>: the daemon makes an agent’s own default
 * folder, but not a project’s, and a turn in one that doesn’t exist fails.
 * @param {string} run  the run’s stamp, letters, digits, - and _
 */
export function workScript(run) {
  if (!/^[\w-]+$/.test(run)) throw new Error(`“${run}” isn’t a run’s stamp.`);
  return `umask 077\nmkdir -p "$HOME/postbox-uat/${run}"`;
}

/**
 * What of one host turn still runs: its runner’s session (from runner.json), and anything naming the turn.
 * @param {string} turn  a UUID
 */
export function turnScript(turn) {
  if (!UUID.test(turn)) throw new Error(`“${turn}” isn’t a turn ID.`);
  const pat = `[${turn[0]}]${turn.slice(1)}`;
  return [
    `d="$HOME/.postbox-remote/turns/${turn}"`,
    `pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$d/runner.json" 2>/dev/null | head -n 1)`,
    `if [ -n "$pid" ]; then ps -o pid=,args= -s "$pid" 2>/dev/null; fi`,
    `pgrep -a -u "$(id -u)" -f '${pat}' || true`,
  ].join('\n');
}

/**
 * Puts P0’s launcher on the host (tools/uat/claude-launcher.mjs) under ~/postbox-uat/bin, with a sh wrapper that
 * runs it with the host’s Node and the real Claude Code, and prints the wrapper’s path, for claudePath.
 * @param {{ launcher: string, node: string, claude: string }} o  the launcher’s source; Node’s and Claude Code’s paths there
 */
export function launcherScript({ launcher, node, claude }) {
  for (const [what, p] of [
    ['Node’s path', node],
    ['Claude Code’s path', claude],
  ])
    if (!PLAIN_PATH.test(p)) throw new Error(`${what} on the host, “${p}”, has characters the launcher’s wrapper won’t quote.`);
  const end = 'POSTBOX_UAT_END';
  if (launcher.split('\n').includes(end)) throw new Error('The launcher’s source has the line that ends it in the script.');
  const wrapper = [
    '#!/bin/sh',
    `POSTBOX_UAT_REAL_CLAUDE='${claude}'`,
    'export POSTBOX_UAT_REAL_CLAUDE',
    `exec '${node}' "$HOME/postbox-uat/bin/claude-launcher.mjs" "$@"`,
  ];
  return [
    'umask 077',
    'mkdir -p "$HOME/postbox-uat/bin"',
    `cat > "$HOME/postbox-uat/bin/claude-launcher.mjs" <<'${end}'`,
    launcher.replace(/\n$/, ''),
    end,
    `cat > "$HOME/postbox-uat/bin/claude" <<'${end}'`,
    ...wrapper,
    end,
    'chmod 700 "$HOME/postbox-uat/bin/claude"',
    'printf %s "$HOME/postbox-uat/bin/claude"',
  ].join('\n');
}

/**
 * Runs a script on the host over the runner’s own ssh. Never throws for the script’s exit; a timeout kills ssh.
 * @param {string} destination  checked already (shared/remote-settings.mjs, checkDestination) @param {string} script
 * @param {{ timeout?: number, spawn?: typeof nodeSpawn }} [o]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function onHost(destination, script, { timeout = 60_000, spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs(destination), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => (stderr += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr.trim().slice(-600) });
    });
    child.stdin.end(`${script}\n`);
  });
}

/** ssh’s arguments: never a prompt, and a remote command that is always `sh -s`. @param {string} destination */
export const sshArgs = (destination) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-T', '--', destination, 'sh', '-s'];

/** Lines of output, trimmed, without empty ones. @param {string} out */
export const linesOf = (out) =>
  String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** pgrep -a’s and ps’s lines, one per process (a line that starts with its PID), each as it was printed. @param {string} out */
export const processesOf = (out) => [...new Map(linesOf(out).flatMap((l) => (/^\d+(?:\s|$)/.test(l) ? [[l.split(/\s+/)[0], l]] : []))).values()];

/**
 * The host’s listeners, with which of them the run’s own processes hold: a process of a session one of Postbox’s
 * processes on the host is in (the daemon’s, a runner’s, whose children are the harness and its commands).
 * @param {string} out  SCRIPTS.listeners’s output
 * @returns {{ addr: string, pids: string[] }[] & { run?: Set<string> }}
 */
export function hostListeners(out) {
  const [ss, ps = ''] = String(out).split('--ps--');
  const listening = linesOf(ss)
    .filter((l) => l.startsWith('LISTEN'))
    .map((l) => ({ addr: l.split(/\s+/)[3] ?? '', pids: [...l.matchAll(/pid=(\d+)/g)].map((m) => m[1]) }));
  const rows = linesOf(ps).flatMap((l) => {
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? [{ pid: m[1], sid: m[2], args: m[3] }] : [];
  });
  const sids = new Set(rows.filter((r) => /\.postbox-remote\//.test(r.args)).map((r) => r.sid));
  const run = new Set(rows.filter((r) => sids.has(r.sid)).map((r) => r.pid));
  return Object.assign(listening, { run });
}
