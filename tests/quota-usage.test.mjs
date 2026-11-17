// A backend’s quota usage kept for the composer’s quota line (#442, server/quota-usage.mjs): checked and bounded, keyed
// as the agents’ out-of-quota marks are, written only when it shows something new or the last is old, and never
// marking or clearing an agent’s quota itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { quotaReport, REWRITE_MS, recordQuota } from '../server/quota-usage.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import * as arrange from './arrange.mjs';

/** The little of a runtime recordQuota reads: the personas, the quota records, and the store’s emit. */
function fakeRt(personas) {
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
const report = (used, status = 'ok') => ({ status, windows: [{ name: '5 h', used, resetsAt: 1_800_000_000_000 }] });

test('a report keeps at most six windows with a name and a share from 0 to 1, and an unknown status is ok', () => {
  const r = quotaReport({
    status: 'exploded',
    windows: [
      { name: '5 h', used: 0.5, resetsAt: 1 },
      { name: '', used: 0.5 },
      { name: 'x', used: 2 },
      { name: 'a', used: 0.1 },
      { name: 'b', used: 0.1 },
      { name: 'c', used: 0.1 },
      { name: 'd', used: 0.1, resetsAt: -5 },
      { name: 'e', used: 0.1 },
      { name: 'f', used: 0.1 },
    ],
  });
  assert.equal(r?.status, 'ok');
  assert.deepEqual(
    r?.windows.map((w) => w.name),
    ['5 h', 'a', 'b', 'c', 'd', 'e'],
  );
  assert.equal(quotaReport({ status: 'ok', windows: [] }), null);
  assert.equal(quotaReport('nothing'), null);
});

test('a report is kept under the quota key: the backend, or backend@host for an agent on a host', () => {
  const { rt, emitted } = fakeRt({ here: { backend: 'claude-code' }, there: { backend: 'codex', remote: { hostId: 'ho_1' } } });
  recordQuota(rt, { personaId: 'here' }, report(0.4), 1000);
  recordQuota(rt, { personaId: 'there' }, report(0.1), 1000);
  assert.deepEqual(
    emitted.map(([type, d]) => [type, d.id, d.backend, d.host, d.seenAt]),
    [
      ['quota', 'claude-code', 'claude-code', null, 1000],
      ['quota', 'codex@ho_1', 'codex', 'ho_1', 1000],
    ],
  );
});

test('a report that shows what the last one did is written again only once the last is ten minutes old', () => {
  const { rt, emitted } = fakeRt({ p: { backend: 'claude-code' } });
  const se = { personaId: 'p' };
  recordQuota(rt, se, report(0.4), 0);
  recordQuota(rt, se, report(0.401), 60_000);
  assert.equal(emitted.length, 1, 'the same whole percent, a minute on');
  recordQuota(rt, se, report(0.41), 120_000);
  assert.equal(emitted.length, 2, 'a new percent');
  recordQuota(rt, se, report(0.41, 'warning'), 130_000);
  assert.equal(emitted.length, 3, 'a new status');
  recordQuota(rt, se, report(0.41, 'warning'), 130_000 + REWRITE_MS);
  assert.equal(emitted.length, 4, 'the same, but the last is ten minutes old');
});

test('a sparse report merges with the last by window: a window it leaves out keeps its figure', () => {
  const { rt } = fakeRt({ p: { backend: 'codex' } });
  const se = { personaId: 'p' };
  const at = 1_800_000_000_000;
  recordQuota(
    rt,
    se,
    {
      status: 'ok',
      windows: [
        { name: '5 h', used: 0.2, resetsAt: at },
        { name: '7 d', used: 0.9, resetsAt: at },
      ],
    },
    0,
  );
  recordQuota(rt, se, { status: 'ok', windows: [{ name: '5 h', used: 0.3, resetsAt: at }] }, 1000);
  assert.deepEqual(
    rt.s.quota.codex.windows.map((w) => [w.name, w.used]),
    [
      ['5 h', 0.3],
      ['7 d', 0.9],
    ],
  );
});

test('each window keeps when it was last reported, so one an update leaves out grows old on its own', () => {
  const { rt } = fakeRt({ p: { backend: 'codex' } });
  const se = { personaId: 'p' };
  recordQuota(
    rt,
    se,
    {
      status: 'ok',
      windows: [
        { name: '5 h', used: 0.2, resetsAt: null },
        { name: '7 d', used: 0.9, resetsAt: null },
      ],
    },
    0,
  );
  recordQuota(rt, se, { status: 'ok', windows: [{ name: '5 h', used: 0.3, resetsAt: null }] }, 2 * 3_600_000);
  assert.deepEqual(
    rt.s.quota.codex.windows.map((w) => [w.name, w.seenAt]),
    [
      ['5 h', 2 * 3_600_000],
      ['7 d', 0],
    ],
  );
});

test('past six windows, the one reported least recently goes, not the one first seen', () => {
  const { rt } = fakeRt({ p: { backend: 'codex' } });
  const se = { personaId: 'p' };
  const w = (name, used = 0.1) => ({ name, used, resetsAt: null });
  recordQuota(rt, se, { status: 'ok', windows: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => w(n)) }, 0);
  recordQuota(rt, se, { status: 'ok', windows: [w('a', 0.5)] }, 60_000);
  recordQuota(rt, se, { status: 'ok', windows: [w('g')] }, 120_000);
  const names = rt.s.quota.codex.windows.map((x) => x.name).sort();
  assert.equal(names.length, 6);
  assert.ok(names.includes('a'), 'a, updated since, stays');
  assert.ok(names.includes('g'), 'the new one stays');
});

test('windows of different limits are kept apart, though they share a name', () => {
  const { rt } = fakeRt({ p: { backend: 'codex' } });
  const se = { personaId: 'p' };
  recordQuota(rt, se, { status: 'ok', windows: [{ name: '5 h', used: 0.2, resetsAt: null }] }, 0);
  recordQuota(rt, se, { status: 'ok', windows: [{ name: '5 h', used: 0.7, resetsAt: null, limit: 'codex_other' }] }, 1000);
  assert.deepEqual(
    rt.s.quota.codex.windows.map((w) => [w.name, w.limit ?? null, w.used]),
    [
      ['5 h', null, 0.2],
      ['5 h', 'codex_other', 0.7],
    ],
  );
});

test('an out report changes no agent’s quota: only a refused turn marks them (turn-quota.mjs)', () => {
  const { rt, emitted } = fakeRt({ p: { backend: 'claude-code' } });
  const se = { id: 'se_1', personaId: 'p' };
  rt.s.sessions = { se_1: se };
  recordQuota(rt, se, report(1, 'out'), 0);
  assert.deepEqual(
    emitted.map(([type]) => type),
    ['quota'],
  );
  assert.equal('quota' in se, false);
});

test('a quota event keeps its record under its key, and a later one replaces it', () => {
  const s = emptyState();
  apply(s, 'quota', { id: 'codex', backend: 'codex', host: null, ...report(0.2), seenAt: 1 });
  apply(s, 'quota', { id: 'codex', backend: 'codex', host: null, ...report(0.3), seenAt: 2 });
  assert.deepEqual(Object.keys(s.quota), ['codex']);
  assert.equal(s.quota.codex.windows[0].used, 0.3);
  assert.equal(s.quota.codex.seenAt, 2);
});

test('an out report through the adapter and the turn leaves every agent’s quota alone, and keeps the record', async () => {
  const store = new Store(null);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(null);
  });
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {
        return null;
      },
      async deliver(_session, _message, ctx) {
        const m = createStreamMapper(ctx);
        m.push({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 2_000_000_000 } } },
        });
        // Held while the test looks: a turn that ends well clears every mark on its quota (turn-quota.mjs’s quotaBack).
        await held;
        ctx.text('Done.');
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'reporter' });
  const b = rt.createPersona({ handle: 'neighbor' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  rt.sendMessage(t.id, { text: '@reporter go' });
  for (let i = 0; i < 200 && !store.state.quota.mock; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.state.quota.mock?.status, 'out');
  for (const se of arrange.sessionsIn(rt, t.id)) assert.equal(se.quota ?? null, null, se.handle);
  release();
  rt.close?.();
});
