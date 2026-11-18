// Antigravity’s quota as Postbox starts (#1494, askAgyQuota in server/backends.mjs): agy’s /usage is asked once, with no
// turn, for a room with an Antigravity agent on this computer, so its bar shows before that agent’s first turn. The
// turn probe’s once-a-minute limit holds across both.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EVERY_MS, usageData, usageProbe } from '../server/adapters/agy-usage.mjs';
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

/** A probe whose ask counts its calls, on a clock the test sets. */
function probe(t = 1_000_000) {
  const clock = { t, asks: 0 };
  const usage = usageProbe(
    async () => {
      clock.asks++;
      return answer;
    },
    { now: () => clock.t },
  );
  return { usage, clock };
}

test('a room with an Antigravity agent here gets agy’s quota as Postbox starts, read when it was asked', async () => {
  const { rt, emitted } = fakeRt({ p1: { backend: 'claude-code' }, p2: { backend: 'antigravity-cli' } });
  const { usage, clock } = probe();
  await askAgyQuota(rt, usage, '1.5.10');
  assert.equal(clock.asks, 1);
  assert.equal(emitted.length, 1);
  const [type, d] = emitted[0];
  assert.equal(type, 'quota');
  assert.equal(d.id, 'antigravity-cli');
  assert.equal(d.backend, 'antigravity-cli');
  assert.equal(d.host, null);
  assert.equal(d.windows.length, 5);
  assert.ok(d.seenAt <= Date.now());
});

test('a turn that starts within the minute doesn’t ask agy again', async () => {
  const { rt } = fakeRt({ p: { backend: 'antigravity-cli' } });
  const { usage, clock } = probe();
  await askAgyQuota(rt, usage, '1.5.10');
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
    await askAgyQuota(rt, usage, /** @type {any} */ (version));
    assert.equal(clock.asks, 0, JSON.stringify([personas, version]));
    assert.equal(emitted.length, 0);
  }
});

test('an agy that can’t answer records nothing, and a failure never reaches Postbox’s start', async () => {
  const { rt, emitted } = fakeRt({ p: { backend: 'antigravity-cli' } });
  for (const ask of [async () => null, async () => Promise.reject(new Error('signed out'))]) {
    await askAgyQuota(rt, usageProbe(ask), '1.5.10');
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
  );
  assert.equal(emitted.length, 0);
});
