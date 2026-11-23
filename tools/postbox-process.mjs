#!/usr/bin/env node
// The launcher for a background process an agent starts (#1614, designs/architecture/background-processes.md, “The
// launcher”). start_process gives the agent this command line, and the agent runs it with its own shell tool, so its
// harness judges the command in the persona’s mode:
//
//   node <postbox>/tools/postbox-process.mjs run <id> -- <the command, as words>
//
// The copy the shell runs (the foreground launcher) starts a second copy, the leader, in a session of its own
// (detached: setsid), and waits. Postbox binds the leader by its ancestry in ps, records it, and sends it the
// go-ahead (GO_SIGNAL, shared/process-launch.mjs). Only then does the leader tell the foreground launcher, through a
// pipe it inherited, and run the command as its own child, in its own group, which it leads. Without a go-ahead in 30 s both exit, and nothing ran. When the
// command exits, the leader stops what is left in its group (SIGINT, then SIGKILL after a grace period), and exits.
//
// It runs the command as an argument array, never through a shell, writes no file anywhere, and never calls Postbox.
// Output and the exit status reach Postbox in a later change, over a socket; until then the command’s output goes
// nowhere.

import { execFile, spawn } from 'node:child_process';
import { closeSync, realpathSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GO_SIGNAL, LAUNCH_WAIT_MS, LEADER_FLAG, launchArgs, PROCESS_ID } from '../shared/process-launch.mjs';

/** How long the leader gives what its command left running between SIGINT and SIGKILL. */
const GRACE_MS = 3000;
/** The inherited pipe the leader reports the go-ahead on. */
const GO_FD = 3;
const SELF = fileURLToPath(import.meta.url);

/**
 * The launcher’s arguments, or why they’re wrong. Between the id and `--` come its options: `--leader` on the leader’s
 * copy, and the socket’s path once output has a channel.
 * @param {string[]} argv  the arguments after the script’s path
 * @returns {{ id: string, leader: boolean, command: string[] } | { error: string }}
 */
export function parseArgs(argv) {
  const [verb, id, ...rest] = argv;
  const usage = 'Run it as: node postbox-process.mjs run <id> -- <command> [arguments…], with the id start_process gave you.';
  if (verb !== 'run') return { error: `postbox-process only runs a command. ${usage}` };
  if (!PROCESS_ID.test(id ?? '')) return { error: `“${String(id ?? '').slice(0, 40)}” isn’t a process id from start_process. ${usage}` };
  const dash = rest.indexOf('--');
  if (dash < 0) return { error: `The command goes after --. ${usage}` };
  const options = rest.slice(0, dash);
  const unknown = options.filter((o) => o !== LEADER_FLAG);
  if (unknown.length) return { error: `postbox-process doesn’t take “${unknown[0].slice(0, 40)}”. ${usage}` };
  const command = rest.slice(dash + 1);
  if (!command.length || !command[0]) return { error: `There’s no command after --. ${usage}` };
  return { id, leader: options.includes(LEADER_FLAG), command };
}

/** The wait for the go-ahead: LAUNCH_WAIT_MS, or less for a test that sets POSTBOX_PROCESS_WAIT_MS. @param {NodeJS.ProcessEnv} env */
export function waitMs(env) {
  const asked = Number(env.POSTBOX_PROCESS_WAIT_MS);
  return Number.isFinite(asked) && asked >= 100 ? Math.min(asked, LAUNCH_WAIT_MS) : LAUNCH_WAIT_MS;
}

/**
 * The foreground launcher: starts the leader in a new session, then waits until it reports the go-ahead, or exits
 * without one. A last timer, past the leader’s own wait, stops a leader that hangs; it’s still this process’s child, so
 * its pid can’t have gone to another process.
 * @param {{ id: string, command: string[] }} args @param {number} wait
 */
function foreground({ id, command }, wait) {
  const leader = spawn(process.execPath, [SELF, ...launchArgs(id, command, { leader: true })], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const pipe = /** @type {import('node:stream').Readable} */ (leader.stdio[GO_FD]);
  let done = false;
  const finish = (/** @type {boolean} */ started) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (started) process.stdout.write(`started ${id}\n`);
    else process.stderr.write('Postbox couldn’t confirm this launch, so it didn’t start.\n');
    process.exitCode = started ? 0 : 1;
    pipe.destroy();
    leader.unref();
  };
  const timer = setTimeout(() => {
    leader.kill('SIGKILL');
    finish(false);
  }, wait + 5000);
  pipe.once('data', () => finish(true));
  pipe.once('close', () => finish(false));
  leader.once('error', () => finish(false));
}

/**
 * The leader: waits for Postbox’s go-ahead, reports it to the foreground launcher, and runs the command. A second
 * go-ahead is ignored: the handler stays, since without one the signal would end the process.
 * @param {{ command: string[] }} args @param {number} wait
 */
function leader({ command }, wait) {
  let started = false;
  const timer = setTimeout(() => process.exit(3), wait);
  process.on(GO_SIGNAL, () => {
    if (started) return;
    started = true;
    clearTimeout(timer);
    try {
      writeSync(GO_FD, 'g');
      // Closed before the command starts, so it doesn’t inherit the pipe.
      closeSync(GO_FD);
    } catch {
      // The foreground launcher is gone already (its own timer ran out): the go-ahead stands, and the command runs.
    }
    run(command);
  });
}

/**
 * Runs the command as this leader’s child, in its group, and stops what it leaves behind once it exits. The leader
 * ignores SIGINT from here on: a Stop’s SIGINT to the group reaches the command, and the leader stays to clean up.
 * @param {string[]} command
 */
function run(command) {
  process.on('SIGINT', () => {});
  const child = spawn(command[0], command.slice(1), { stdio: 'ignore' });
  child.once('error', () => void sweep(127));
  child.once('exit', (code) => void sweep(code ?? 1));
}

/** SIGINT to the rest of the group, then SIGKILL to the whole group (this leader last) if any of it is left after the grace period. */
async function sweep(/** @type {number} */ code) {
  signalOwnGroup('SIGINT');
  const until = Date.now() + GRACE_MS;
  while (Date.now() < until) {
    if (!(await othersInGroup())) process.exit(code);
    await new Promise((r) => setTimeout(r, 100));
  }
  signalOwnGroup('SIGKILL');
  process.exit(code);
}

/** @param {NodeJS.Signals} signal */
function signalOwnGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch {
    // The group is gone already but for this process, which can’t be: nothing to signal.
  }
}

/** Whether a process other than this leader is still in its group. When ps can’t say, it’s taken as yes. */
function othersInGroup() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,pgid='], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(true);
      const me = process.pid;
      resolve(
        String(out)
          .split('\n')
          .some((line) => {
            const [pid, pgid] = line.trim().split(/\s+/).map(Number);
            return pgid === me && pid !== me;
          }),
      );
    });
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    process.stderr.write(`${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  const wait = waitMs(process.env);
  if (args.leader) leader(args, wait);
  else foreground(args, wait);
}

/** Whether this file is what node ran, through any link to it, rather than a test’s import. */
const ranDirectly = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === SELF;
  } catch {
    return false;
  }
};

if (ranDirectly()) main();
