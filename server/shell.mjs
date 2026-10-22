// `!command` in the composer (#67): runs a command line the person typed, in the conversation’s folder, as them.
//
// It runs through the person’s shell ($SHELL -c, else /bin/sh), with the command line as one argument. The practices
// doc says never to spawn through a shell, and that rule is about strings from agents or data, which must never be
// parsed as shell. This one is the person’s own command line, typed as in their terminal, where pipes, globs and `&&`
// are the point. The route that calls this needs the page’s token (#74), and refuses unless Postbox listens on this
// computer alone.

import { spawn } from 'node:child_process';

/** Stop’s grace period between SIGINT and SIGKILL. */
const KILL_AFTER_MS = 3000;

/** Whether an address is this computer’s own (the listen address, or where a request came from). */
export function isLoopback(address) {
  const a = String(address ?? '').replace(/^::ffff:/, '');
  return a === '::1' || a === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * Starts a command. Output (stdout and stderr, in the order it arrives) goes to onOutput; onExit gets
 * { code, signal } when it ends, or { error } when it couldn’t start. Returns { stop, kill, done }: stop sends SIGINT to
 * the command and everything it started, then SIGKILL if it hasn’t ended; kill sends SIGKILL now; done resolves when
 * it has ended.
 * @param {{ command: string, cwd: string, spawnImpl?: typeof spawn, shell?: string, env?: NodeJS.ProcessEnv, killAfterMs?: number,
 *           onOutput: (text: string) => void, onExit: (r: { code?: number|null, signal?: string|null, error?: Error }) => void }} opts
 */
export function runShell({
  command,
  cwd,
  spawnImpl = spawn,
  shell = process.env.SHELL || '/bin/sh',
  env = process.env,
  killAfterMs = KILL_AFTER_MS,
  onOutput,
  onExit,
}) {
  let ended = false;
  /** @type {NodeJS.Timeout|undefined} */
  let killTimer;
  /** @type {(v?: any) => void} */
  let finished = () => {};
  const done = new Promise((r) => {
    finished = r;
  });
  const end = (r) => {
    if (ended) return;
    ended = true;
    clearTimeout(killTimer);
    onExit(r);
    finished();
  };
  let child;
  try {
    // Its own process group (detached), so Stop reaches what the command started too. No stdin: nothing can answer
    // a prompt, so a command that asks waits for Stop.
    child = spawnImpl(shell, ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  } catch (e) {
    end({ error: e });
    return { stop: () => false, kill: () => false, done };
  }
  const signal = (sig) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', (d) => onOutput(String(d)));
  child.stderr?.on('data', (d) => onOutput(String(d)));
  child.on('error', (e) => end({ error: e }));
  child.on('close', (code, sig) => end({ code, signal: sig }));
  return {
    stop() {
      if (ended) return false;
      signal('SIGINT');
      killTimer = setTimeout(() => signal('SIGKILL'), killAfterMs);
      killTimer.unref?.();
      return true;
    },
    kill() {
      if (ended) return false;
      signal('SIGKILL');
      return true;
    },
    done,
  };
}
