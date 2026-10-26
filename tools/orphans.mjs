// Test browsers and servers a killed run left behind, stopped at the start of the next run. Playwright starts each
// browser in its own process group and closes it only from the worker’s exit and signal handlers, and tools/cdp.mjs
// and the UAT runner stop their Chrome and server from JavaScript too, so a run killed outright (SIGKILL, as an agent
// harness does to a background job when its turn ends) leaves them running under launchd, holding memory. An agent’s
// Playwright runs left ten such browsers, about 5.5 GB, in one afternoon.
//
// Only what is certainly ours and certainly orphaned is stopped: a process whose parent is gone (ppid 1) and whose
// command line names one of our own temporary profiles or data folders. Your own Chrome, its crash handler, your own
// Postbox and any other tool’s server never match. A Playwright crash handler names no profile, so it’s stopped only
// when no Playwright browser is running at all.

import { execFile } from 'node:child_process';

/** @typedef {{ pid: number, ppid: number, command: string }} Proc */
/** @typedef {{ pid: number, kind: 'playwright-browser' | 'playwright-crashpad' | 'cdp-chrome' | 'postbox-server', command: string }} Orphan */

/** Parses `ps -axww -o pid=,ppid=,command=`. @param {string} out @returns {Proc[]} */
export function parsePs(out) {
  return String(out)
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

const PLAYWRIGHT = '/ms-playwright/';
/** The value of a `--flag=value` or `--flag value` argument, up to the next space. */
const arg = (command, flag) => new RegExp(`(?:^|\\s)${flag}[= ](\\S+)`).exec(command)?.[1] ?? null;
/** The last path segment. */
const base = (path) => String(path).replace(/\/+$/, '').split('/').pop() ?? '';

/** A Playwright browser’s main process: the build Playwright installs, with a profile Playwright made. */
const isPlaywrightBrowser = (c) =>
  c.includes(PLAYWRIGHT) &&
  !c.includes('--type=') &&
  !c.includes('chrome_crashpad_handler') &&
  base(arg(c, '--user-data-dir') ?? '').startsWith('playwright_chromiumdev_profile-');
/** A Postbox server a test tool started: its data in a UAT run’s folder, or installed in one of our temp folders. */
function isTestServer(c) {
  if (!/\/server\/index\.mjs(\s|$)|\/node_modules\/\.bin\/postbox(\s|$)/.test(c)) return false;
  const data = arg(c, '--data');
  if (data?.includes('/uat-runs/')) return true;
  const program = c.split(/\s+/).find((w) => /\/server\/index\.mjs$|\/node_modules\/\.bin\/postbox$/.test(w)) ?? '';
  return program.split('/').some((s) => /^pb-[\w-]+$/.test(s));
}

/**
 * What to stop: our own test browsers and servers whose parent is gone.
 * @param {Proc[]} procs @returns {Orphan[]}
 */
export function orphans(procs) {
  const found = /** @type {Orphan[]} */ ([]);
  for (const p of procs) {
    if (p.ppid !== 1) continue;
    const c = p.command;
    if (isPlaywrightBrowser(c)) found.push({ pid: p.pid, kind: 'playwright-browser', command: c });
    else if (!c.includes('--type=') && base(arg(c, '--user-data-dir') ?? '').startsWith('pb-cdp-')) found.push({ pid: p.pid, kind: 'cdp-chrome', command: c });
    else if (isTestServer(c)) found.push({ pid: p.pid, kind: 'postbox-server', command: c });
  }
  // A crash handler can’t be told from a running browser’s, so only once every Playwright browser is one we stop.
  const stopping = new Set(found.map((o) => o.pid));
  const browsersLeft = procs.some((p) => isPlaywrightBrowser(p.command) && !stopping.has(p.pid));
  if (!browsersLeft)
    for (const p of procs)
      if (p.ppid === 1 && p.command.includes(PLAYWRIGHT) && p.command.includes('chrome_crashpad_handler'))
        found.push({ pid: p.pid, kind: 'playwright-crashpad', command: p.command });
  return found;
}

/** The processes running now, as `ps` lists them. @returns {Promise<Proc[]>} */
export function listPs() {
  return new Promise((resolve) => {
    execFile('ps', ['-axww', '-o', 'pid=,ppid=,command='], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? [] : parsePs(out)));
  });
}

/**
 * Stops what `orphans` finds, with SIGTERM, which lets Chrome and Postbox close. Never throws: a run goes on either way.
 * @param {{ list?: () => Promise<Proc[]>, kill?: (pid: number, signal: string) => void, log?: (line: string) => void }} [opts]
 * @returns {Promise<Orphan[]>} what it stopped
 */
export async function stopOrphans({ list = listPs, kill = process.kill, log = () => {} } = {}) {
  if (process.platform === 'win32') return [];
  const found = orphans(await list().catch(() => []));
  const stopped = found.filter((o) => {
    try {
      kill(o.pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  });
  if (stopped.length) {
    const counts = [...new Set(stopped.map((o) => o.kind))].map((kind) => `${stopped.filter((o) => o.kind === kind).length} ${kind}`);
    log(`Stopped what an earlier run left behind: ${counts.join(', ')} (pids ${stopped.map((o) => o.pid).join(' ')}).`);
  }
  return stopped;
}
