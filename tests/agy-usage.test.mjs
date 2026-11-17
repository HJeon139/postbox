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
import { agyUsage, EVERY_MS, usageData, usageProbe } from '../server/adapters/agy-usage.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { agyQuota } from '../server/adapters/quota-windows.mjs';
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

test('it asks at most once a minute, and hands the turn what agy said', async () => {
  let now = 0;
  let asks = 0;
  const probe = usageProbe(
    async () => {
      asks++;
      return { groups: [{ name: 'Gemini Models', buckets: [bucket('5h', 0.6)] }] };
    },
    { now: () => now },
  );
  const reports = [];
  const ctx = { quota: (r) => reports.push(r) };
  await probe.report(ctx, probe.start());
  now = EVERY_MS - 1;
  await probe.report(ctx, probe.start());
  now = EVERY_MS;
  await probe.report(ctx, probe.start());
  assert.equal(asks, 2, 'not again within the minute');
  assert.equal(reports.length, 2);
  assert.equal(reports[0].windows[0].used, 0.4);
});

test('a probe that fails reports nothing, and the turn goes on', async () => {
  const probe = usageProbe(() => Promise.reject(new Error('signed out')));
  const reports = [];
  await probe.report({ quota: (r) => reports.push(r) }, probe.start());
  assert.deepEqual(reports, []);
});

test('a turn reports what agy’s /usage said before it ends, and its reply still comes', async () => {
  const root = tempDir('pb-agy-usage-');
  const lines = readFileSync(new URL('fixtures/antigravity-cli/first.jsonl', import.meta.url), 'utf8').trim();
  const seen = [];
  const quotas = [];
  let text = '';
  const adapter = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (fakeAgy(`${lines}\n`, 0, seen)),
    env: {},
    usage: usageProbe(async () => ({ groups: [{ name: 'Gemini Models', buckets: [bucket('weekly', 0.9)] }] })),
  });
  await adapter.deliver(
    {},
    { kind: 'user', text: 'hi' },
    {
      signal: new AbortController().signal,
      mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
      persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'bypass', tools: [], description: '', instructions: '' },
      project: null,
      handles: ['gem'],
      state: {},
      saveState() {},
      pathOf: () => null,
      text: (d) => {
        text += d;
      },
      activity() {},
      status() {},
      reported() {},
      quota: (r) => quotas.push(r),
    },
  );
  assert.equal(seen.length, 1, 'the turn alone ran agy: the probe asked through its own function');
  assert.ok(text, 'the reply came');
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].windows[0].name, '7 d');
  assert.ok(Math.abs(quotas[0].windows[0].used - 0.1) < 1e-9);
});
