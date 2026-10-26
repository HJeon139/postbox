// What the ssh connection’s tests share (tests/remote-ssh*.test.mjs): the host, the version and the command ssh
// runs, settings, a fake clock, and a connection over the fake ssh.

import { createSshConnection } from '../server/remote/ssh.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { FAKE_TOKEN } from './fake-daemon.mjs';

export const HOST = 'host.example.com';
export const VERSION = '0.10.0';

export const flush = () => new Promise((r) => setImmediate(r));

/** A fake clock: timers run only when a test fires them. */
export function fakeClock() {
  /** @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    /** Runs the pending timers, oldest first, and says which waits they had. */
    fire() {
      const due = timers.filter((t) => !t.cleared);
      for (const t of due) t.cleared = true;
      for (const t of due) t.fn();
      return due.map((t) => t.ms);
    },
    pending: () => timers.filter((t) => !t.cleared).map((t) => t.ms),
  };
}

export const connection = (o) => createSshConnection({ destination: HOST, settings: defaultHostSettings(), version: VERSION, token: FAKE_TOKEN, ...o });
