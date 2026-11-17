// Antigravity CLI’s quota (#1466, server/adapters/agy-usage.mjs and agyQuota in quota-windows.mjs): what
// `agy --print /usage --output-format json` answers, read into the contract’s `quota` kind, asked at most once a minute,
// and reported to the turn. The fixture is the answer of agy 1.5.10, as #1466 gives it, with every remaining fraction
// scrubbed to 1 (tools/privacy-check.mjs) and the reset times rounded; the shares here are made up.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { agyHasUsage, agyUsage, EVERY_MS, usageData, usageProbe } from '../server/adapters/agy-usage.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { agyQuota } from '../server/adapters/quota-windows.mjs';
import { REWRITE_MS, reportedAt } from '../server/quota-usage.mjs';
import { tempDir } from './temp-dirs.mjs';

const answer = readFileSync(new URL('fixtures/antigravity-cli/usage.json', import.meta.url), 'utf8');
/** A pool’s window with the share left and its reset. */
const bucket = (window, remaining_fraction, reset_time = '2026-11-18T02:00:00Z') => ({ window, remaining_fraction, reset_time });

test('the recorded answer reads as every pool’s windows, each limit but Gemini’s named after its pool', () => {
  const report = agyQuota(usageData(answer));
  assert.equal(report?.status, 'ok');
  assert.deepEqual(report?.windows, [
    { name: '7 d', used: 0, resetsAt: Date.parse('2026-11-21T00:00:00Z') },
    { name: '5 h', used: 0, resetsAt: Date.parse('2026-11-18T02:00:00Z') },
    { name: '7 d', used: 0, resetsAt: Date.parse('2026-11-24T21:00:00Z'), limit: 'Claude and GPT models', limitName: 'Claude and GPT models' },
    { name: '5 h', used: 0, resetsAt: Date.parse('2026-11-18T02:00:00Z'), limit: 'Claude and GPT models', limitName: 'Claude and GPT models' },
    { name: '7 d', used: 0, resetsAt: Date.parse('2026-11-24T21:00:00Z'), limit: 'Gemini 4 Argon', limitName: 'Gemini 4 Argon' },
  ]);
});

test('a share left reads as the share used, and a window with nothing left is out', () => {
  const report = agyQuota({ groups: [{ name: 'Gemini Models', buckets: [bucket('5h', 0.25), bucket('weekly', 0)] }] });
  assert.deepEqual(
    report?.windows.map((w) => w.used),
    [0.75, 1],
  );
  assert.equal(report?.status, 'out');
});

test('a window it can’t read is left out, and an answer with none is no report', () => {
  const odd = [bucket('monthly', 0.5), bucket('5h', 1.2), bucket('5h', -0.1), bucket('5h', '0.5'), { window: '5h' }];
  assert.equal(agyQuota({ groups: [{ name: 'Gemini Models', buckets: odd }] }), null);
  const unread = agyQuota({ groups: [{ name: 'Gemini Models', buckets: [bucket('5h', 0.5, 'soon')] }] });
  assert.deepEqual(unread?.windows, [{ name: '5 h', used: 0.5, resetsAt: null }], 'a reset it can’t read is none');
  assert.equal(agyQuota(null), null);
  assert.equal(agyQuota({ groups: 'none' }), null);
});

test('only a successful usage answer is read', () => {
  assert.equal(usageData('not json'), null);
  assert.equal(usageData(JSON.stringify({ status: 'ERROR', command: { name: 'usage', data: {} } })), null);
  assert.equal(usageData(JSON.stringify({ status: 'SUCCESS', command: { name: 'models', data: {} } })), null);
  assert.ok(usageData(answer)?.groups);
});

/** A fake agy that answers once with text and an exit code, recording its arguments. */
function fakeAgy(text, code, seen) {
  return (_bin, args) => {
    seen.push(args);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    setImmediate(() => {
      /** @type {any} */ (child).stdout.end(text);
      /** @type {any} */ (child).stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
}

test('a probe that never answers is stopped at its time limit, and reads as nothing', async () => {
  const signals = [];
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(/** @type {string} */ sig) {
      signals.push(sig);
      setImmediate(() => child.emit('close', null));
    },
  });
  assert.equal(await agyUsage('agy', { spawnImpl: /** @type {any} */ (() => child), timeoutMs: 5 }), null);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('agy is asked with /usage in print mode, as JSON, and a failed answer is null', async () => {
  const seen = [];
  assert.ok((await agyUsage('agy', { spawnImpl: /** @type {any} */ (fakeAgy(answer, 0, seen)) }))?.groups);
  assert.deepEqual(seen[0], ['--print', '/usage', '--output-format', 'json']);
  assert.equal(await agyUsage('agy', { spawnImpl: /** @type {any} */ (fakeAgy(answer, 1, seen)) }), null);
  const throws = () => {
    throw new Error('ENOENT');
  };
  assert.equal(await agyUsage('agy', { spawnImpl: /** @type {any} */ (throws) }), null);
});

const NEW = '1.5.10';
const answering = (left) => async () => ({ groups: [{ name: 'Gemini Models', buckets: [bucket('5h', left)] }] });

test('only an agy from 1.5.10 is asked, since an older one could take /usage as a paid prompt', () => {
  for (const v of ['1.5.10', '1.5.11', '1.6.0', '2.0.0', '1.5.10-beta']) assert.equal(agyHasUsage(v), true, v);
  for (const v of ['1.5.9', '1.4.7', '0.9.0', '', null, undefined, 'unknown']) assert.equal(agyHasUsage(v), false, String(v));
  let asks = 0;
  const probe = usageProbe(async () => {
    asks++;
    return null;
  });
  assert.equal(probe.start('1.5.9'), null);
  assert.equal(probe.start(null), null);
  assert.equal(asks, 0);
});

test('it asks at most once a minute, and hands the turn what agy said with when it was asked', async () => {
  let now = 1_000;
  let asks = 0;
  const probe = usageProbe(
    async () => {
      asks++;
      return answering(0.6)();
    },
    { now: () => now },
  );
  const reports = [];
  const ctx = { quota: (r) => reports.push(r) };
  const asked = probe.start(NEW);
  now += 30_000; // the turn runs
  await probe.report(ctx, asked);
  now = 1_000 + EVERY_MS - 1;
  await probe.report(ctx, probe.start(NEW));
  now = 1_000 + EVERY_MS;
  await probe.report(ctx, probe.start(NEW));
  assert.equal(asks, 2, 'not again within the minute');
  assert.equal(reports.length, 2);
  assert.equal(reports[0].windows[0].used, 0.4);
  assert.equal(reports[0].seenAt, 1_000, 'as of the ask, not the turn’s end');
});

test('a report’s time is kept only when it’s past and recent, so it can’t pass for fresher or older', () => {
  const now = 10 * REWRITE_MS;
  assert.equal(reportedAt({ seenAt: now - 30_000 }, now), now - 30_000);
  assert.equal(reportedAt({ seenAt: now + 1 }, now), now, 'never in the future');
  assert.equal(reportedAt({ seenAt: now - REWRITE_MS }, now), now, 'never older than a rewrite');
  assert.equal(reportedAt({}, now), now);
});

test('a probe that fails reports nothing, and the turn goes on', async () => {
  const probe = usageProbe(() => Promise.reject(new Error('signed out')));
  const reports = [];
  await probe.report({ quota: (r) => reports.push(r) }, probe.start(NEW));
  assert.deepEqual(reports, []);
});

test('Stop doesn’t wait on the probe: a stopped turn reports nothing and ends at once', async () => {
  const never = usageProbe(() => new Promise(() => {}));
  const reports = [];
  const stopped = new AbortController();
  stopped.abort();
  await never.report({ signal: stopped.signal, quota: (r) => reports.push(r) }, never.start(NEW));
  // Stopped while it waits on agy.
  const later = new AbortController();
  const slow = usageProbe(() => new Promise(() => {}));
  const waiting = slow.report({ signal: later.signal, quota: (r) => reports.push(r) }, slow.start(NEW));
  later.abort();
  await waiting;
  assert.deepEqual(reports, []);
});

/** An Antigravity adapter on agy 1.5.10 that plays one recorded turn, its probe answering with left. */
function adapterWith(root, turn, code, left, seen) {
  const lines = readFileSync(new URL(`fixtures/antigravity-cli/${turn}.jsonl`, import.meta.url), 'utf8').trim();
  return new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    version: NEW,
    spawnImpl: /** @type {any} */ (fakeAgy(`${lines}\n`, code, seen)),
    env: {},
    usage: usageProbe(answering(left)),
  });
}

/** A turn’s context, recording its reply and its quota reports. */
const turnCtx = (quotas, said = { text: '' }) => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'bypass', tools: [], description: '', instructions: '' },
  project: null,
  handles: ['gem'],
  state: {},
  saveState() {},
  pathOf: () => null,
  text: (d) => {
    said.text += d;
  },
  activity() {},
  status() {},
  reported() {},
  quota: (r) => quotas.push(r),
});

test('a turn reports what agy’s /usage said before it ends, and its reply still comes', async () => {
  const seen = [];
  const quotas = [];
  const said = { text: '' };
  await adapterWith(tempDir('pb-agy-usage-'), 'first', 0, 0.9, seen).deliver({}, { kind: 'user', text: 'hi' }, turnCtx(quotas, said));
  assert.equal(seen.length, 1, 'the turn alone ran agy: the probe asked through its own function');
  assert.ok(said.text, 'the reply came');
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].windows[0].name, '5 h');
  assert.ok(Math.abs(quotas[0].windows[0].used - 0.1) < 1e-9);
});

test('a turn that fails, as one out of quota does, still reports what agy said', async () => {
  const quotas = [];
  const adapter = adapterWith(tempDir('pb-agy-usage-'), 'fail-before-output', 1, 0, []);
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'hi' }, turnCtx(quotas)), Error);
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].status, 'out');
});
