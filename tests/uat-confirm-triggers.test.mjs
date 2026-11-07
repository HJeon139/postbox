// #852 slice 1a's UAT triggers, read from a room a real Runtime recorded: a confirm, its command run once with no card,
// then the same command again with a card the person denied. The seed's own test starts git, so it's in
// tests/process/uat-bare-remote.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import { afterBlock, bash, confirm, setup } from './requested-setup.mjs';

const PUSH = 'git push origin HEAD:refs/heads/uat-confirm';
const fired = (s, id) => TRIGGERS[id].run({ threads: [s.t.id], state: { items: { [s.t.id]: s.store.items(s.t.id) } } });

test('#852 confirmed-command-ran fires for the confirmed run, and carded-again for the second run’s card', async () => {
  const s = await setup({ permissionMode: 'ask' });
  assert.deepEqual(fired(s, 'confirmed-command-ran'), []);
  assert.deepEqual(await afterBlock(s, confirm(`Runs:\n\n\`\`\`\n${PUSH}\n\`\`\``), ['confirm', {}], [bash(PUSH), bash(PUSH)]), [true, false]);
  const [ran, ...more] = fired(s, 'confirmed-command-ran');
  assert.deepEqual(more, []);
  assert.match(ran.evidence, /^@now ran “git push origin HEAD:refs\/heads\/uat-confirm”, as confirmed \(Push 2d7c9a65\)\.$/);
  const [again, ...others] = fired(s, 'confirmed-command-carded-again');
  assert.deepEqual(others, []);
  assert.match(again.evidence, /The same command again got a card/);
});

test('#852 the triggers don’t fire for a card with no confirmed run before it, or a line the judge allowed', async () => {
  const s = await setup({ permissionMode: 'ask' });
  const se = s.rt.sessionsIn(s.t.id)[0];
  s.rt.addItem(s.t.id, { kind: 'allowedcall', sessionId: se.id, handle: 'now', tool: 'Bash', detail: PUSH, how: 'asked', quote: 'push it', status: 'allowed' });
  s.rt.addItem(s.t.id, { kind: 'permission', sessionId: se.id, handle: 'now', tool: 'Bash', input: { command: PUSH }, detail: '', status: 'denied' });
  assert.deepEqual(fired(s, 'confirmed-command-ran'), []);
  assert.deepEqual(fired(s, 'confirmed-command-carded-again'), []);
});

test('the confirmrun scenario’s phases are there to cause each trigger', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/confirmrun.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.equal(s.seed, 'bare-remote');
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [['confirmed-command-ran'], ['confirmed-command-carded-again']],
  );
});
