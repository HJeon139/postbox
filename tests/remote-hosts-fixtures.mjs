// What the host manager’s tests share (tests/remote-hosts*.test.mjs): a manager over the fake daemon and a temp data
// folder, a test clock, and waiting until something holds.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostManager } from '../server/remote/hosts.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';

export const VERSION = '0.10.0';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(2);
  }
}

/**
 * A clock for the manager: now() is the test’s, and timers of a second or more (the idle grace, the status throttle,
 * the check’s wait, ssh’s welcome timeout) wait for advance(); shorter ones (the 5 ms backoff) run for real.
 */
export function testClock() {
  let t = 1_760_000_000_000;
  /** @type {{ at: number, fn: () => void, real?: any }[]} */
  const held = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      if (ms < 1000) return { real: setTimeout(fn, ms) };
      const h = { at: t + ms, fn };
      held.push(h);
      return h;
    },
    clearTimer(h) {
      if (h?.real) return clearTimeout(h.real);
      const i = held.indexOf(h);
      if (i !== -1) held.splice(i, 1);
    },
    held,
    advance(ms) {
      t += ms;
      for (;;) {
        const due = held.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        held.splice(held.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

/**
 * A manager over a temp data folder, with hosts h1 (installed: its token is written) and h2 (not), and a fake ssh to
 * a fake daemon. o.settings: h1’s settings over the defaults; o.spawn replaces the fake ssh; o.delay is the backoff;
 * o.hostIds lists the configured hosts (none by default).
 */
export function setup({
  daemon = createFakeDaemon({ autoEnd: false }),
  settings = {},
  spawn = undefined,
  token = FAKE_TOKEN,
  delay = 5,
  hostIds = undefined,
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pbh-'));
  const hosts = {
    h1: { id: 'h1', name: 'host.example.com', settings: { ...defaultHostSettings(), ...settings }, createdAt: 1 },
    h2: { id: 'h2', name: 'other.example.com', settings: defaultHostSettings(), createdAt: 1 },
  };
  if (token) {
    mkdirSync(join(dataDir, 'remote-tokens'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'remote-tokens', 'h1'), `${token}\n`, { mode: 0o600 });
  }
  const ssh = fakeSsh({ daemon });
  const clock = testClock();
  const mgr = createHostManager({
    getHost: (id) => hosts[id] ?? null,
    dataDir,
    version: VERSION,
    spawn: spawn ?? ssh.spawn,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delay: () => delay,
    ...(hostIds ? { hostIds } : {}),
  });
  /** @type {{ id: string, state: string, lastHeard: number | null }[]} */
  const statuses = [];
  mgr.on('status', (id, s) => statuses.push({ id, state: s.state, lastHeard: s.lastHeard }));
  const done = () => {
    mgr.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { mgr, hosts, dataDir, daemon, ssh, clock, statuses, done };
}

export const SIGN_IN = 'user@host.example.com: Permission denied (publickey).\r\n'; // tests/fixtures/ssh/failures.json
