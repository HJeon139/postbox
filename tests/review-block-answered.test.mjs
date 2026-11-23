// #716: a reviewer’s review_block on a review the person already answered. In the #508 room, design reads of approved
// pages went into the room as prose, apart from the block they discussed, because review_block refused once the block
// was answered. Now the comments land on it as threads, under the person’s answer, without reopening it; its agent
// hears them. A review its agent withdrew still takes none (tests/review-block.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

const draft = {
  id: 'plan',
  type: 'review',
  version: 1,
  title: 'plan.md',
  fallback: 'The plan',
  format: 'markdown',
  content: '# Plan\n\nWe index first.\nLast line.',
};

test('#716 a reviewer comments on a review the person already answered: the threads land, and the answer stands', async () => {
  const store = new Store(null);
  /** @type {any[]} */
  const heard = [];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(_s, m) {
        heard.push(m);
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const personas = ['researcher', 'critic'].map((handle) => rt.createPersona({ handle }).id);
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: personas });
  const [mine, theirs] = ['researcher', 'critic'].map((h) => arrange.agentIn(rt, t.id, h));
  assert.equal(rt.toolsFor(mine.id).show_block({ block: draft }).ok, true);
  const item = () => store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  const answer = item().answer;

  const r = rt.toolsFor(theirs.id).review_block({ blockId: 'plan', verdict: 'comment', comments: [{ line: 3, text: 'A read of the approved design.' }] });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /The person already answered it, and your comments don’t reopen it\./);
  assert.deepEqual(
    item().block.threads.map((th) => [th.line, th.comments[0].author, th.comments[0].text]),
    [[3, '@critic', 'A read of the approved design.']],
  );
  assert.equal(item().answered, true, 'still answered');
  assert.deepEqual(item().answer, answer, 'the answer as the person gave it');
  assert.deepEqual(
    item().reviews.map((rv) => [rv.handle, rv.verdict]),
    [['critic', 'comment']],
  );
  // The block’s agent hears it in a turn of its own.
  const review = () => heard.find((m) => m.kind === 'event' && m.event?.action === 'review');
  for (let i = 0; i < 100 && !review(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(review()?.event.values.comments[0].text, 'A read of the approved design.');
  // Told the person answered it, so a revision would ask them again; not to revise as if it still waited on them.
  const said = formatMessage(review());
  assert.match(
    said,
    /The person already answered this block: resolving one in update_block’s threads\? keeps their answer, while changing its content asks them again\./,
  );
  assert.doesNotMatch(said, /still waits on the person/);
});
