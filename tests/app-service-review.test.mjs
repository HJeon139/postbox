// Apps’ review_block (designs/architecture/services.md, “Apps”): an agent’s comments on another agent’s review block,
// and how its author hears of them. On the Apps rig (tests/app-service-fixture.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig } from './app-service-fixture.mjs';

test('reviewBlock comments on another agent’s review and tells it through send; a send that throws is said in the reply', () => {
  const { store, threads, apps, sent } = rig();
  const review = { id: 'rv', type: 'review', version: 1, fallback: 'A draft to review.', format: 'markdown', title: 'Draft', content: 'one\ntwo\n' };
  threads.addItem('th_c', { kind: 'block', valid: true, sessionId: 'se_1', handle: 'alpha', block: review });
  const r = apps.reviewBlock('se_2', { blockId: 'rv', comments: [{ line: 1, text: 'Shorter.' }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].sessionId, sent[0].message.event.action, sent[0].message.event.from], ['se_1', 'review', 'beta']);
  const failing = rig();
  failing.threads.addItem('th_c', { kind: 'block', valid: true, sessionId: 'se_1', handle: 'alpha', block: review });
  failing.apps.send = () => {
    throw new Error('Postbox is closing');
  };
  assert.match(failing.apps.reviewBlock('se_2', { blockId: 'rv', comments: [{ line: 1, text: 'x' }] }).message, /didn’t hear them: Postbox is closing/);
  assert.equal(store.items('th_c').at(-1).reviews.length, 1);
});
