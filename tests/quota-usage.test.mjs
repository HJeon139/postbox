// A backend’s quota usage kept for the composer’s quota line (#442, server/quota-usage.mjs): checked and bounded, keyed
// as the agents’ out-of-quota marks are, written only when it shows something new or the last is old, and never
// marking or clearing an agent’s quota itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaReport, REWRITE_MS, recordQuota } from '../server/quota-usage.mjs';
import { apply, emptyState } from '../shared/state.mjs';

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

test('a report keeps at most four windows with a name and a share from 0 to 1, and an unknown status is ok', () => {
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
    ],
  });
  assert.equal(r?.status, 'ok');
  assert.deepEqual(
    r?.windows.map((w) => w.name),
    ['5 h', 'a', 'b', 'c'],
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
