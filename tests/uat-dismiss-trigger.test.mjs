// #883's UAT trigger: the person dismissed a failed reply. Read from a room's items as a run records them, made by a
// real Runtime: a turn that fails, then Dismiss (server/card-needs.mjs dismissFailed).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dismissFailed } from '../server/card-needs.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import * as arrange from './arrange.mjs';
import { room } from './card-needs-fixture.mjs';
import { settle } from './side-threads-fixture.mjs';

const fired = (r) => TRIGGERS['failed-reply-dismissed'].run({ threads: [r.t.id], state: { items: { [r.t.id]: r.store.items(r.t.id) } } });

async function failed() {
  const r = room();
  r.adapter.next.push(async () => {
    throw new Error('API Error: Request rejected (429). Too many tokens.');
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await settle(r.rt);
  const it = r.store.items(r.t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  return { ...r, it };
}

test('#883 failed-reply-dismissed fires once a failed reply is dismissed, with its error as evidence', async () => {
  const r = await failed();
  assert.deepEqual(fired(r), [], 'not before Dismiss');
  dismissFailed(r.rt, r.t.id, r.it.id);
  const [hit, ...rest] = fired(r);
  assert.deepEqual(rest, []);
  assert.match(hit.evidence, /@alpha’s failed reply was dismissed: “API Error: Request rejected \(429\)/);
});

test('#883 failed-reply-dismissed doesn’t fire for a failed reply that was only retried, or a dismissed card that isn’t a reply', async () => {
  const r = await failed();
  arrange.setItem(r.rt, r.t.id, r.it.id, { status: 'retried' });
  arrange.post(r.rt, r.t.id, { kind: 'permission', sessionId: r.alpha.id, status: 'expired', dismissed: true, summary: 'run ls' });
  // A failed command line carrying the field isn't a reply the person dismissed.
  arrange.post(r.rt, r.t.id, { kind: 'command', sessionId: r.alpha.id, status: 'failed', dismissed: true, command: 'ls' });
  assert.deepEqual(fired(r), []);
});

test('#883 a reply dismissed and then retried still counts: it was dismissed first', async () => {
  const r = await failed();
  dismissFailed(r.rt, r.t.id, r.it.id);
  arrange.setItem(r.rt, r.t.id, r.it.id, { status: 'retried' });
  const [hit] = fired(r);
  assert.match(hit?.evidence ?? '', /dismissed: .*, then retried\.$/);
});

test('the dismissfailed scenario’s phase is there to cause it, with the fault that fails the turn', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/dismissfailed.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [['failed-reply-dismissed'], []],
  );
});
