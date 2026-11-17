// Antigravity CLI’s quota usage (#1466; designs/architecture/adapters.md, “Quota: each backend’s usage, in the
// composer”). agy’s turn stream carries none, but `agy --print /usage --output-format json` answers with each model
// pool’s 5-hour and weekly windows, and runs no model to do it, from agy 1.5.10. The adapter asks as a turn starts, at
// most once a minute, and reports the answer, with when it was read, before the turn ends, while the turn can still
// record it. So the turn never waits on agy to end, and Stop never waits on it at all.

import { spawn } from 'node:child_process';
import { stopProbe } from '../remote/host/probe-stop.mjs';
import { agyQuota } from './quota-windows.mjs';

/** How long the probe may take: agy answers in a second or two. */
const PROBE_MS = 10_000;
/** The least time between two probes. */
export const EVERY_MS = 60_000;

/**
 * Whether this agy answers /usage without a model: from 1.5.10, as #1466 saw it. An older one could take “/usage” as a
 * prompt, a paid turn, so it isn’t asked. @param {string | null | undefined} version
 */
export function agyHasUsage(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj > 1 || (maj === 1 && (min > 5 || (min === 5 && patch >= 10)));
}

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
 * Asks agy for its usage. Null if it can’t: agy missing, signed out, or slower than timeoutMs, when it’s stopped.
 * @param {string} bin @param {{ spawnImpl?: typeof spawn, timeoutMs?: number }} [opts] @returns {Promise<any>}
 */
export function agyUsage(bin, { spawnImpl = spawn, timeoutMs = PROBE_MS } = {}) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let p;
    try {
      p = spawnImpl(bin, ['--print', '/usage', '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => stopProbe(p), timeoutMs);
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

/** The answer, or null once the signal aborts, whichever comes first. @param {Promise<any>} asked @param {AbortSignal | undefined} signal */
function unlessStopped(asked, signal) {
  if (!signal) return asked;
  if (signal.aborted) return Promise.resolve(null);
  /** @type {() => void} */
  let off = () => {};
  const stopped = new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    off = () => signal.removeEventListener('abort', onAbort);
  });
  return Promise.race([asked, stopped]).finally(off);
}

/**
 * The adapter’s probe: start(version) as a turn starts, which asks an agy that can answer unless it asked in the last
 * minute, and report(ctx, asked) before the turn ends, which hands what agy said, and when, to the turn’s ctx.quota.
 * @param {() => Promise<any>} ask @param {{ now?: () => number }} [opts]
 */
export function usageProbe(ask, { now = Date.now } = {}) {
  let at = -Infinity;
  return {
    /** @param {string | null | undefined} version @returns {Promise<{ data: any, at: number } | null> | null} */
    start(version) {
      if (!agyHasUsage(version) || now() - at < EVERY_MS) return null;
      const asking = now();
      at = asking;
      return ask().then(
        (data) => ({ data, at: asking }),
        () => null,
      );
    },
    /**
     * The turn’s run, then its report, whether the run ended well or failed, as one out of quota does.
     * @param {any} ctx @param {Promise<{ data: any, at: number } | null> | null} asked @param {Promise<void>} ran
     */
    async reportAfter(ctx, asked, ran) {
      try {
        await ran;
      } finally {
        await this.report(ctx, asked);
      }
    },
    /** @param {any} ctx @param {Promise<{ data: any, at: number } | null> | null} asked */
    async report(ctx, asked) {
      if (!asked) return;
      const got = await unlessStopped(asked, ctx.signal);
      const report = got && agyQuota(got.data);
      if (report && !ctx.signal?.aborted) ctx.quota?.({ ...report, seenAt: got.at });
    },
  };
}
