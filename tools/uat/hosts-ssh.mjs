// The runner’s own ssh to a host (#120), to check what Postbox can’t say about itself: what runs there, what listens,
// which turns are there, and whether ~/.postbox-remote is gone; and to break things on purpose (kill the daemon) and
// put P0’s launcher there. The ssh is an argument list, in BatchMode, with a fixed remote command, `sh -s`: each
// script is a constant fed on stdin, so the login shell parses nothing but that, whatever it is. The only value a
// script takes is a turn ID, checked as a UUID first, the run’s stamp, and the launcher’s two paths, checked as plain
// absolute paths. A script that measures ends with END only when every program it measured with ran: a missing
// pgrep or ss reads as “couldn’t say”, never as “nothing there” (upToEnd). The parsers are pure, so tests feed them
// recorded output.

import { spawn as nodeSpawn } from 'node:child_process';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A path the launcher’s script may quote as it is: absolute, with nothing a shell or a quote would read. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/+@-]+$/;
/** A run’s stamp, as tools/uat-run.mjs makes it. */
const STAMP = /^[\w-]+$/;
// A pattern that matches what it names but not itself: “[.]postbox-remote” in pgrep’s own arguments isn’t “.postbox-remote”.
const ONE = '[.]postbox-remote';
/** The last line of a measuring script that got to its end. */
export const END = '--end--';
/** What the scripts measure with on a host: the runner checks each is there before it sets anything up. */
export const NEEDS = ['pgrep', 'pkill', 'ps', 'ss', 'sed'];

/** The remote scripts, by what they check. Each prints only what its parser reads. */
export const SCRIPTS = {
  // Which of NEEDS the host lacks, one line each.
  preflight: `for c in ${NEEDS.join(' ')}; do command -v "$c" >/dev/null 2>&1 || echo "missing $c"; done; echo '${END}'`,
  // Everything of Postbox’s running as this user: the daemon, its relays, the runners and the shims. pgrep exits 1
  // when nothing matches, and more when it can’t run.
  processes: `pgrep -a -u "$(id -u)" -f '${ONE}'; s=$?; if [ "$s" -gt 1 ]; then exit "$s"; fi; echo '${END}'`,
  // TCP listeners, with their processes where ss can say, then this user’s processes and their sessions.
  listeners: `{ ss -ltnp 2>/dev/null || ss -ltn; } || exit 4; echo '--ps--'; ps -u "$(id -u)" -o pid=,sid=,args= || exit 5; echo '${END}'`,
  turns: `ls -1 "$HOME/.postbox-remote/turns" 2>/dev/null || true`,
  removed: `if [ -e "$HOME/.postbox-remote" ]; then echo present; else echo absent; fi`,
  killDaemon: `pkill -KILL -u "$(id -u)" -f '${ONE}/[^ ]*/host[.]mjs serve'; s=$?; if [ "$s" -eq 0 ]; then echo killed; elif [ "$s" -eq 1 ]; then echo none; else exit "$s"; fi`,
  // Each turn’s runner (its PID, from runner.json), then this user’s processes with their parents, groups, sessions
  // and start times: what turnTrees and stillRunning read.
  tree: [
    'for f in "$HOME"/.postbox-remote/turns/*/runner.json; do',
    '  [ -f "$f" ] || continue',
    '  t=$(basename "$(dirname "$f")")',
    `  p=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$f" | head -n 1)`,
    '  if [ -n "$p" ]; then echo "turn $t $p"; fi',
    'done',
    "echo '--ps--'",
    'ps -u "$(id -u)" -o pid=,ppid=,pgid=,sid=,lstart=,args= || exit 5',
    `echo '${END}'`,
  ].join('\n'),
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
 * A measuring script’s output before its END, or null when it didn’t get there: ssh failed, or a program it measures
 * with is missing or failed. @param {{ code: number|null, stdout: string }} r
 */
export function upToEnd(r) {
  const lines = String(r.stdout ?? '')
    .replace(/\n+$/, '')
    .split('\n');
  return r.code === 0 && lines.at(-1)?.trim() === END ? lines.slice(0, -1).join('\n') : null;
}

/**
 * Runs a measuring script on the host: its output before END, or null and why it didn’t get there.
 * @param {string} destination @param {string} script @param {{ timeout?: number, spawn?: typeof nodeSpawn }} [o]
 * @returns {Promise<{ out: string|null, why: string|null }>}
 */
export async function measureOn(destination, script, o) {
  const r = await onHost(destination, script, o);
  const out = upToEnd(r);
  return {
    out,
    why: out === null ? r.stderr || `its script ended (${r.code === null ? 'killed at its timeout' : `exit ${r.code}`}) before it measured anything` : null,
  };
}

/** The run’s own folder on the host, under ~/postbox-uat, for a script to quote. @param {string} run  the run’s stamp */
const runDir = (run) => {
  if (!STAMP.test(run)) throw new Error(`“${run}” isn’t a run’s stamp.`);
  return `$HOME/postbox-uat/${run}`;
};

/**
 * Makes the run’s own folder on the host, ~/postbox-uat/<run>, with the project’s folder in it (work: the daemon
 * makes an agent’s own default folder, but not a project’s, and a turn in one that doesn’t exist fails) and bin for
 * P0’s launcher. It refuses a folder that’s already there, which isn’t this run’s to delete. Prints “made” when it
 * made ~/postbox-uat too, so cleanUpScript removes that only then.
 * @param {string} run  the run’s stamp, letters, digits, - and _
 */
export function workScript(run) {
  const dir = runDir(run);
  return [
    'umask 077',
    'if [ ! -e "$HOME/postbox-uat" ]; then mkdir "$HOME/postbox-uat" || exit 1; echo made; fi',
    `if [ -e "${dir}" ]; then echo "~/postbox-uat/${run} is already there, and isn’t this run’s." >&2; exit 3; fi`,
    `mkdir "${dir}" "${dir}/work" "${dir}/bin"`,
  ].join('\n');
}

/**
 * Removes what workScript made: the run’s own folder, and ~/postbox-uat only if the run made it and it’s empty now.
 * Exits 1 unless the run’s folder is gone. @param {string} run @param {{ parent?: boolean }} [o]  parent: workScript
 * said it made ~/postbox-uat
 */
export function cleanUpScript(run, { parent = false } = {}) {
  const dir = runDir(run);
  return [
    `rm -rf -- "${dir}"`,
    `if [ -e "${dir}" ]; then echo "~/postbox-uat/${run} is still there." >&2; exit 1; fi`,
    ...(parent ? ['rmdir "$HOME/postbox-uat" 2>/dev/null'] : []),
    'echo removed',
  ].join('\n');
}

/**
 * Puts P0’s launcher on the host (tools/uat/claude-launcher.mjs) in the run’s own folder, ~/postbox-uat/<run>/bin,
 * with a sh wrapper that runs it with the host’s Node and the real Claude Code, and prints the wrapper’s path, for
 * claudePath. workScript made the folder.
 * @param {{ launcher: string, node: string, claude: string, run: string }} o  the launcher’s source; Node’s and Claude
 *   Code’s paths there; the run’s stamp
 */
export function launcherScript({ launcher, node, claude, run }) {
  for (const [what, p] of [
    ['Node’s path', node],
    ['Claude Code’s path', claude],
  ])
    if (!PLAIN_PATH.test(p)) throw new Error(`${what} on the host, “${p}”, has characters the launcher’s wrapper won’t quote.`);
  const end = 'POSTBOX_UAT_END';
  if (launcher.split('\n').includes(end)) throw new Error('The launcher’s source has the line that ends it in the script.');
  const bin = `${runDir(run)}/bin`;
  const wrapper = ['#!/bin/sh', `POSTBOX_UAT_REAL_CLAUDE='${claude}'`, 'export POSTBOX_UAT_REAL_CLAUDE', `exec '${node}' "${bin}/claude-launcher.mjs" "$@"`];
  return [
    'umask 077',
    `cat > "${bin}/claude-launcher.mjs" <<'${end}'`,
    launcher.replace(/\n$/, ''),
    end,
    `cat > "${bin}/claude" <<'${end}'`,
    ...wrapper,
    end,
    `chmod 700 "${bin}/claude"`,
    `printf %s "${bin}/claude"`,
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
 * processes on the host is in (the daemon’s, a runner’s, whose children are the harness and its commands). Throws
 * when ss’s part has no header: what ss always prints, so without it nothing was measured.
 * @param {string} out  SCRIPTS.listeners’s output, up to its END
 * @returns {{ addr: string, pids: string[] }[] & { run?: Set<string> }}
 */
export function hostListeners(out) {
  const [ss, ps] = String(out).split('--ps--');
  if (ps === undefined || !linesOf(ss).some((l) => l.startsWith('State'))) throw new Error('ss printed nothing it would for its listeners.');
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

/** @typedef {{ pid: string, ppid: string, pgid: string, sid: string, start: string, args: string }} HostProc */

// ps’s line: PID, parent, group, session, then lstart (“Sat Oct 24 05:12:33 2026”), then the command.
const PS_LINE = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/;
// The daemon and its relays: their groups and sessions are never a turn’s.
const DAEMON = /\.postbox-remote\/\S*host[.]mjs (?:serve|attach)/;

/**
 * SCRIPTS.tree’s output, up to its END: each turn’s runner PID, and this user’s processes. Throws when it isn’t that.
 * @param {string} out @returns {{ runners: Map<string, string>, procs: HostProc[] }}
 */
export function parseTree(out) {
  const [head, ps] = String(out).split('--ps--');
  if (ps === undefined) throw new Error('The host’s process list didn’t come back.');
  const runners = new Map(
    linesOf(head).flatMap((l) => {
      const m = /^turn (\S+) (\d+)$/.exec(l);
      return m && UUID.test(m[1]) ? [[m[1], m[2]]] : [];
    }),
  );
  const procs = linesOf(ps).flatMap((l) => {
    const m = PS_LINE.exec(l);
    return m ? [{ pid: m[1], ppid: m[2], pgid: m[3], sid: m[4], start: m[5].replace(/\s+/g, ' '), args: m[6] }] : [];
  });
  if (!procs.length) throw new Error('ps listed no processes, not even its own.');
  return { runners, procs };
}

/**
 * What runs under each turn’s runner now: the runner and every process descended from it (the harness, the tool
 * shells it starts in sessions of their own, and what they start). Sampled while the runner lives, since once a
 * process outlives its parent, nothing but its PID and start time tie it to the turn. A runner counts only while its
 * PID runs something of Postbox’s: an old runner.json’s PID may be another process’s by now.
 * @param {{ runners: Map<string, string>, procs: HostProc[] }} tree @returns {Map<string, HostProc[]>}
 */
export function turnTrees({ runners, procs }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out = new Map();
  for (const [turn, pid] of runners) {
    const root = byPid.get(pid);
    if (!root || !/\.postbox-remote\//.test(root.args)) continue;
    const seen = [root];
    for (const p of seen) for (const k of kids.get(p.pid) ?? []) if (!seen.includes(k)) seen.push(k);
    out.set(turn, seen);
  }
  return out;
}

/**
 * Which processes recorded under a turn still run: the same PID with the same start time, or any process in a group
 * or session one of them was in, which a command a tool shell left behind stays in after its shell exits. The
 * daemon’s and its relays’ groups and sessions don’t count, nor one whose leader’s PID now runs another process.
 * @param {HostProc[]} recorded @param {{ procs: HostProc[] }} now @returns {HostProc[]}
 */
export function stillRunning(recorded, { procs }) {
  const was = new Map(recorded.map((p) => [p.pid, p.start]));
  const reused = new Set(procs.filter((p) => was.has(p.pid) && was.get(p.pid) !== p.start).map((p) => p.pid));
  const daemon = new Set(procs.filter((p) => DAEMON.test(p.args)).flatMap((p) => [`g${p.pgid}`, `s${p.sid}`]));
  const groups = new Set(
    recorded.flatMap((p) => [...(reused.has(p.pgid) ? [] : [`g${p.pgid}`]), ...(reused.has(p.sid) ? [] : [`s${p.sid}`])]).filter((g) => !daemon.has(g)),
  );
  return procs.filter((p) => was.get(p.pid) === p.start || groups.has(`g${p.pgid}`) || groups.has(`s${p.sid}`));
}
