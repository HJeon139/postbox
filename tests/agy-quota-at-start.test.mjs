// Antigravity’s quota as Postbox starts (#1494, askAgyQuota in server/backends.mjs): agy’s /usage is asked once, with no
// turn, for a room with an Antigravity agent on this computer, so its bar shows before that agent’s first turn. The
// turn probe’s once-a-minute limit holds across both, and Postbox’s close stops it, with nothing recorded after.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { agyUsage, EVERY_MS, usageData, usageProbe } from '../server/adapters/agy-usage.mjs';
import { askAgyQuota } from '../server/backends.mjs';

const answer = usageData(readFileSync(new URL('fixtures/antigravity-cli/usage.json', import.meta.url), 'utf8'));

/** The little of a runtime recordQuota reads: the personas, the quota records, and the store’s emit. */
function fakeRt(/** @type {Record<string, any>} */ personas) {
  /** @type {any[]} */
  const emitted = [];
  const rt = {
    s: { personas, quota: /** @type {Record<string, any>} */ ({}), sessions: {} },
    store: {
      emit: (/** @type {string} */ type, /** @type {any} */ d) => {
        emitted.push([type, d]);
        rt.s.quota[d.id] = d;
      },
    },
  };
  return { rt, emitted };
}

/** A probe whose ask counts its calls, on a clock the test sets, which moves on by `slow` ms while agy answers. */
function probe(t = 1_000_000, slow = 0) {
  const clock = { t, asks: 0 };
  const usage = usageProbe(
    async () => {
      clock.asks++;
      clock.t += slow;
      return answer;
    },
    { now: () => clock.t },
  );
  return { usage, clock };
}

/** A fake agy that never answers, as a hung one doesn’t: it records the signals it’s sent, and closes on SIGTERM. */
function hungAgy() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    exitCode: /** @type {number | null} */ (null),
    signalCode: /** @type {string | null} */ (null),
    signals: /** @type {string[]} */ ([]),
    kill(/** @type {string} */ sig) {
      child.signals.push(sig);
      child.signalCode = sig;
      queueMicrotask(() => child.emit('close', null));
      return true;
    },
  });
  return child;
}

test('a room with an Antigravity agent here gets agy’s quota as Postbox starts, read when it was asked', async () => {
  const { rt, emitted } = fakeRt({ p1: { backend: 'claude-code' }, p2: { backend: 'antigravity-cli' } });
  const { usage, clock } = probe(1_000_000, 5 * 60_000);
  await askAgyQuota(rt, usage, '1.5.10').done;
  assert.equal(clock.asks, 1);
  assert.equal(emitted.length, 1);
  const [type, d] = emitted[0];
  assert.equal(type, 'quota');
  assert.equal(d.id, 'antigravity-cli');
  assert.equal(d.backend, 'antigravity-cli');
  assert.equal(d.host, null);
  assert.equal(d.windows.length, 5);
  assert.equal(d.seenAt, 1_000_000, 'read when agy was asked, not when it answered');
});

test('a turn that starts within the minute doesn’t ask agy again', async () => {
  const { rt } = fakeRt({ p: { backend: 'antigravity-cli' } });
  const { usage, clock } = probe();
  await askAgyQuota(rt, usage, '1.5.10').done;
  clock.t += EVERY_MS - 1;
  assert.equal(usage.start('1.5.10'), null);
  assert.equal(clock.asks, 1);
});

test('nothing is asked without an Antigravity agent here, or of an agy too old to answer /usage', async () => {
  const cases = [
    [{ p: { backend: 'claude-code' } }, '1.5.10'],
    [{ p: { backend: 'antigravity-cli', remote: { hostId: 'ho_1' } } }, '1.5.10'],
    [{ p: { backend: 'antigravity-cli' } }, '1.5.9'],
    [{ p: { backend: 'antigravity-cli' } }, null],
  ];
  for (const [personas, version] of cases) {
    const { rt, emitted } = fakeRt(/** @type {any} */ (personas));
    const { usage, clock } = probe();
    await askAgyQuota(rt, usage, /** @type {any} */ (version)).done;
    assert.equal(clock.asks, 0, JSON.stringify([personas, version]));
    assert.equal(emitted.length, 0);
  }
});

test('an agy that can’t answer records nothing, and a failure never reaches Postbox’s start', async () => {
  const { rt, emitted } = fakeRt({ p: { backend: 'antigravity-cli' } });
  for (const ask of [async () => null, async () => Promise.reject(new Error('signed out'))]) {
    await askAgyQuota(rt, usageProbe(ask), '1.5.10').done;
  }
  const throwing = {
    ...rt,
    store: {
      emit: () => {
        throw new Error('closed');
      },
    },
  };
  await askAgyQuota(
    throwing,
    usageProbe(async () => answer),
    '1.5.10',
  ).done;
  assert.equal(emitted.length, 0);
});

test('stopped as Postbox closes, a hung agy is sent SIGTERM and nothing is recorded after', async () => {
  const { rt, emitted } = fakeRt({ p: { backend: 'antigravity-cli' } });
  const child = hungAgy();
  const usage = usageProbe((signal) => agyUsage('agy', { spawnImpl: /** @type {any} */ (() => child), signal }));
  const asking = askAgyQuota(rt, usage, '1.5.10');
  asking.stop();
  await asking.done;
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.stdout.end(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: answer } }));
  await new Promise((ok) => setImmediate(ok));
  assert.equal(emitted.length, 0);
});

test('a turn’s stop stops the probe it started, so a hung agy doesn’t outlive the turn', async () => {
  const child = hungAgy();
  const usage = usageProbe((signal) => agyUsage('agy', { spawnImpl: /** @type {any} */ (() => child), signal }));
  const stop = new AbortController();
  /** @type {any[]} */
  const quota = [];
  const asked = usage.start('1.5.10', stop.signal);
  stop.abort();
  await usage.report({ signal: stop.signal, quota: (/** @type {any} */ r) => quota.push(r) }, asked);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.deepEqual(quota, []);
});
