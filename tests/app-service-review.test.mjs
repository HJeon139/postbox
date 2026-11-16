// Apps’ review_block (designs/architecture/services.md, “Apps”): a review of a block is the one entry an agent makes
// without an @-mention, its block’s author’s (designs/rooms-at-scale.md, “What an entry is”). On the Apps rig.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig } from './app-service-fixture.mjs';

test('reviewBlock comments on another agent’s review and tells it with a review entry; a send that throws is said in the reply', () => {
  const { store, threads, apps, sent, entries } = rig();
  const review = { id: 'rv', type: 'review', version: 1, fallback: 'A draft to review.', format: 'markdown', title: 'Draft', content: 'one\ntwo\n' };
  const block = threads.addItem('th_c', { kind: 'block', valid: true, sessionId: 'se_1', handle: 'alpha', block: review });
  const r = apps.reviewBlock('se_2', { blockId: 'rv', comments: [{ line: 1, text: 'Shorter.' }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(sent.length, 0, 'not through the send port');
  assert.deepEqual(
    entries.map((e) => [e.sessionId, e.source, e.itemId, e.from, e.message.event.action]),
    [['se_1', 'review', block.id, 'beta', 'review']],
  );
  const failing = rig();
  failing.threads.addItem('th_c', { kind: 'block', valid: true, sessionId: 'se_1', handle: 'alpha', block: review });
  failing.apps.delivery.send = () => {
    throw new Error('Postbox is closing');
  };
  assert.match(failing.apps.reviewBlock('se_2', { blockId: 'rv', comments: [{ line: 1, text: 'x' }] }).message, /didn’t hear them: Postbox is closing/);
  assert.equal(store.items('th_c').at(-1).reviews.length, 1);
});
