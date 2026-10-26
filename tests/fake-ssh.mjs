// A fake `ssh` for the laptop’s side of #120 (server/remote/ssh.mjs and link.mjs): a spawn function whose children
// have an ssh child’s stdio and events, wired to tests/fake-daemon.mjs, so nothing is run. Moved here from
// tests/remote-ssh.test.mjs so the host link’s tests (tests/remote-link.test.mjs) use the same one.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * A fake ssh. With a daemon, each spawn is a new connection to it, as each real ssh is; when the daemon ends the
 * connection, ssh exits with 0, as it exits with the remote command’s status. `script(child)` replaces the daemon, to
 * write stderr and exit as a failing ssh does.
 * @param {{ daemon?: ReturnType<typeof import('./fake-daemon.mjs').createFakeDaemon>, script?: (child: any) => void, ignoreTerm?: boolean }} o
 */
export function fakeSsh({ daemon, script, ignoreTerm = false } = {}) {
  const calls = [];
  const children = [];
  const spawn = (program, args, options) => {
    calls.push({ program, args, options });
    const io = daemon ? daemon.connect() : { stdin: new PassThrough(), stdout: new PassThrough() };
    if (!daemon) io.stdin.resume();
    const child = Object.assign(new EventEmitter(), { stdin: io.stdin, stdout: io.stdout, stderr: new PassThrough(), kills: [], exited: false });
    child.exit = (code, signal = null) => {
      if (child.exited) return;
      child.exited = true;
      child.stderr.end();
      if (!io.stdout.writableEnded) io.stdout.end();
      // ssh’s end closes the session’s stdin on the host too.
      if (!io.stdin.writableEnded) io.stdin.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    child.fail = (code, stderr) => {
      child.stderr.write(stderr);
      child.exit(code);
    };
    child.kill = (signal = 'SIGTERM') => {
      child.kills.push(signal);
      if (signal === 'SIGKILL' || !ignoreTerm) child.exit(null, signal);
      return true;
    };
    io.stdout.on('end', () => child.exit(0));
    children.push(child);
    if (script) setImmediate(() => script(child));
    return child;
  };
  return { spawn, calls, children };
}
