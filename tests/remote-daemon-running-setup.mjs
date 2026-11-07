// What tests/remote-daemon-running*.test.mjs share (#738): a daemon with a fake clock and its log kept, a turn started
// and read, and one host’s processes as /proc has them, for proc.mjs’s own sameProcess.

import { sameProcess } from '../server/remote/host/proc.mjs';
import { BOOT, fakeClock, hello, setup, startMsg, waitFor } from './remote-daemon-setup.mjs';

export const CEILING_MS = 60_000;

/** A daemon with a fake clock and its log kept. @param {object} [o] more of setup’s options */
export function silentSetup(o = {}) {
  const clock = fakeClock();
  const logs = [];
  const s = setup({ clock, log: (line) => logs.push(line), ...o });
  const ended = (c) => c.msgs.messages.filter((m) => m.type === 'ended');
  /** Waits for the daemon to ask the runner n more times (n more looks at the turn), or for c’s turn to end. */
  const looks = (n, c) => {
    const k = s.asks.length;
    return waitFor(() => s.asks.length >= k + n || (c && ended(c).length > 0));
  };
  return { ...s, clock, logs, looks, ended };
}

/** Starts t1 and reads it. */
export async function startReading(s) {
  const c = await hello(s);
  c.send('start', startMsg('t1'));
  await c.msgs.next('started');
  c.send('read', { turn: 't1', from: 0 });
  return c;
}

/** One host’s processes as /proc has them, for proc.mjs’s sameProcess. */
export function fakeHost() {
  const host = { boot: BOOT, procs: new Map() };
  const opts = {
    platform: 'linux',
    kill: (pid) => {
      if (!host.procs.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    },
    readFile: (path) => {
      if (path === '/proc/sys/kernel/random/boot_id') return `${host.boot}\n`;
      const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
      const p = host.procs.get(pid);
      if (!p) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      // Fields 3 to 22 after the command name: state, then 18 more, then the start time.
      return `${pid} (node) ${p.state} 1 ${pid} ${pid} ${Array(15).fill(0).join(' ')} ${p.start}\n`;
    },
  };
  return { host, sameProcess: (r) => sameProcess(r, opts) };
}

/** Starts t1 over a fake host whose runner process is up, and reads it. */
export async function startOnHost() {
  const fh = fakeHost();
  const s = silentSetup({ sameProcess: fh.sameProcess });
  const c = await startReading(s);
  const pid = 4001;
  fh.host.procs.set(pid, { state: 'S', start: 1234 });
  return { s, c, host: fh.host, pid };
}
