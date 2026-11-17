// #484 with entries (designs/rooms-at-scale.md, “What a turn is given”): a mention is delivered once, as an entry, so
// a turn that runs while it waits leaves it out of the room’s summary, and the turn that takes it gives it whole. No
// summary gives a mention its own entry gives again, so nothing comes as a pointer to one (givenMentions and
// pointerIfSeen are gone).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const MENTION = `@alpha the review of the totals is done: two fixes needed in the tally. ${'Details follow on each fix. '.repeat(8)}`;

test('#484 a mention waiting as an entry is left out of the summary of a turn that runs before it, and reaches the agent once', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await sleep(5);
  const from = f.adapter.calls.length;
  // A check of alpha’s last reply waits first, a turn of its own with the room’s summary, then beta’s mention of alpha.
  const problems = [{ code: 'table', message: 'Fix the table.', scope: { kind: 'item', id: 'it_x' } }];
  arrange.armLint(f.rt, 'tu_lint', { sessionId: f.alpha.id, kind: null, ended: true, sent: false, problems, timer: null, threadId: f.t.id });
  arrange.sendLint(f.rt, 'tu_lint');
  f.adapter.next.push(async (/** @type {any} */ c) => c.text(MENTION));
  f.rt.sendMessage(f.t.id, { text: '@beta tell alpha' });
  await sleep(20);
  busy.release();
  await settle(f.rt);
  await settle(f.rt);
  const alpha = f.adapter.calls.slice(from).filter((c) => c.handle === 'alpha');
  assert.deepEqual(
    alpha.map((c) => c.message.kind),
    ['lint', 'input'],
  );
  const given = alpha.map((c) => JSON.stringify(c.message).split(MENTION.slice(0, 60)).length - 1);
  assert.deepEqual(given, [0, 1], 'the summary left it out, and its own turn gave it once');
});
