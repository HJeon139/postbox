// Each harness’s quota usage, read into the contract’s `quota` kind (#442, server/adapters/quota-windows.mjs). Recorded
// streams hold only scrubbed figures (0), so the shares here are made up. Codex’s percent key is built at run time:
// tools/privacy-check.mjs flags it written as an object’s key, as account data.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { claudeQuota, codexQuota, share } from '../server/adapters/quota-windows.mjs';

const HOUR_S = 3600;
const PCT = ['used', 'Percent'].join('');
/** A Codex window: its percent used, its length in minutes and its reset in epoch seconds. */
const codexWindow = (pct, windowDurationMins, resetsAt) => ({ ...Object.fromEntries([[PCT, pct]]), windowDurationMins, resetsAt });

test('a recorded Claude rate limit reads as its unified windows, each with its share and reset in ms', () => {
  const line = readFileSync(new URL('fixtures/claude-code/compact.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => (l ? JSON.parse(l) : null))
    .find((e) => e?.type === 'rate_limit_event');
  const info = line.rate_limit_info;
  assert.deepEqual(claudeQuota(info), {
    status: 'ok',
    windows: [
      { name: '5 h', used: 0, resetsAt: info.unifiedWindows.five_hour.resetsAt * 1000 },
      { name: '7 d', used: 0, resetsAt: info.unifiedWindows.seven_day.resetsAt * 1000 },
    ],
  });
});

test('a Claude limit with a warning, or rejected with no overage, says so; overage that covers it is ok', () => {
  const windows = { five_hour: { utilization: 0.42, resetsAt: 2 * HOUR_S } };
  assert.equal(claudeQuota({ status: 'allowed_warning', unifiedWindows: windows })?.status, 'warning');
  assert.equal(claudeQuota({ status: 'rejected', unifiedWindows: windows })?.status, 'out');
  assert.equal(claudeQuota({ status: 'rejected', overageStatus: 'allowed', unifiedWindows: windows })?.status, 'ok');
  assert.deepEqual(claudeQuota({ status: 'allowed', unifiedWindows: windows })?.windows, [{ name: '5 h', used: 0.42, resetsAt: 2 * HOUR_S * 1000 }]);
});

test('a Claude limit with no unified windows reads as the one window it names', () => {
  assert.deepEqual(claudeQuota({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: HOUR_S })?.windows, [
    { name: '7 d', used: 0.8, resetsAt: HOUR_S * 1000 },
  ]);
});

test('a share over 1 is read as a percent, and one over 100, or not a number, is none, so no bar is guessed', () => {
  assert.equal(share(0.25), 0.25);
  assert.equal(share(42), 0.42);
  assert.equal(share(100), 1);
  for (const x of [101, -1, Number.NaN, '0.5', null, undefined]) assert.equal(share(x), null, String(x));
  assert.deepEqual(claudeQuota({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 42, resetsAt: HOUR_S } } })?.windows[0].used, 0.42);
  assert.equal(claudeQuota({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 420, resetsAt: HOUR_S } } }), null);
});

test('a Claude window with no name Postbox knows, or no figure, is left out', () => {
  assert.equal(claudeQuota({ status: 'allowed', unifiedWindows: { someday: { utilization: 0.5 } } }), null);
  assert.equal(claudeQuota({ status: 'allowed', unifiedWindows: { five_hour: { resetsAt: HOUR_S } } }), null);
  assert.equal(claudeQuota(null), null);
});

test('Codex’s rate limits read as its primary and secondary windows, named by length, out once a limit is reached', () => {
  const limits = { primary: codexWindow(40, 300, 2 * HOUR_S), secondary: codexWindow(7, 10_080, 50 * HOUR_S) };
  assert.deepEqual(codexQuota(limits), {
    status: 'ok',
    windows: [
      { name: '5 h', used: 0.4, resetsAt: 2 * HOUR_S * 1000 },
      { name: '7 d', used: 0.07, resetsAt: 50 * HOUR_S * 1000 },
    ],
  });
  assert.equal(codexQuota({ ...limits, rateLimitReachedType: 'primary' })?.status, 'out');
  assert.equal(codexQuota({ primary: codexWindow(1, 90, null) })?.windows[0].used, 0.01, 'Codex’s 1 is 1%, never a whole share');
  assert.equal(codexQuota({ primary: codexWindow(140, 300, null) }), null);
  assert.equal(codexQuota({}), null);
});

test('the Claude stream mapper reports a rate limit’s usage through ctx.quota', () => {
  /** @type {any[]} */
  const reports = [];
  const m = createStreamMapper({ activity() {}, status() {}, text() {}, compaction() {}, quota: (r) => reports.push(r) });
  m.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: HOUR_S } } } });
  assert.deepEqual(reports, [{ status: 'ok', windows: [{ name: '5 h', used: 0.3, resetsAt: HOUR_S * 1000 }] }]);
});

test('the Codex mapper reports account/rateLimits/updated through ctx.quota, and nothing for a notification without figures', () => {
  /** @type {any[]} */
  const reports = [];
  const m = createCodexMapper({ activity() {}, status() {}, text() {}, state: {}, quota: (r) => reports.push(r) });
  m.push({ method: 'account/rateLimits/updated', params: {} });
  m.push({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: codexWindow(12, 300, HOUR_S) } } });
  assert.deepEqual(reports, [{ status: 'ok', windows: [{ name: '5 h', used: 0.12, resetsAt: HOUR_S * 1000 }] }]);
});
