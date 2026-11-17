// Antigravity CLI’s quota usage (#1466; designs/architecture/adapters.md, “Quota: each backend’s usage, in the
// composer”). agy’s turn stream carries none, but `agy --print /usage --output-format json` answers with each model
// pool’s 5-hour and weekly windows, and runs no model to do it. The adapter asks alongside a turn, at most once a
// minute, and reports the answer before the turn ends, while the turn can still record it.

import { spawn } from 'node:child_process';
import { stopProbe } from '../remote/host/probe-stop.mjs';
import { agyQuota } from './quota-windows.mjs';

/** How long the probe may take: agy answers in a second or two. */
const PROBE_MS = 10_000;
/** The least time between two probes. */
export const EVERY_MS = 60_000;

/** What `agy --print /usage --output-format json` reports: its `command.data`, or null if it failed or said something else. */
export function usageData(/** @type {string} */ text) {
  try {
    const r = JSON.parse(text);
    return r?.status === 'SUCCESS' && r.command?.name === 'usage' ? (r.command.data ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Asks agy for its usage. Null if it can’t: agy missing, signed out, or slow.
 * @param {string} bin @param {{ spawnImpl?: typeof spawn }} [opts] @returns {Promise<any>}
 */
export function agyUsage(bin, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let p;
    try {
      p = spawnImpl(bin, ['--print', '/usage', '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => stopProbe(p), PROBE_MS);
    p.stdout.on('data', (d) => {
      out = (out + d).slice(-200_000);
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? usageData(out) : null);
    });
  });
}

/**
 * The adapter’s probe: start() as a turn starts, which asks unless it asked in the last minute, and report() before
 * the turn ends, which hands what agy said to the turn’s ctx.quota.
 * @param {() => Promise<any>} ask @param {{ now?: () => number }} [opts]
 */
export function usageProbe(ask, { now = Date.now } = {}) {
  let at = -Infinity;
  return {
    /** @returns {Promise<any> | null} */
    start() {
      if (now() - at < EVERY_MS) return null;
      at = now();
      return ask().catch(() => null);
    },
    /** @param {any} ctx @param {Promise<any> | null} asked */
    async report(ctx, asked) {
      const report = asked && agyQuota(await asked);
      if (report) ctx.quota?.(report);
    },
  };
}
