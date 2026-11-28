// review_block refuses a region comment on a non-app review (server/review-comments.mjs, placeError, #856).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './blocks-fixture.mjs';

const box = { x: 120, y: 90, w: 200, h: 45, width: 1000, height: 300, version: 1 };

test('#856 review_block refuses a region comment on a markdown review', () => {
  const s = setup();
  const a = s.rt.createPersona({ handle: 'author' });
  const b = s.rt.createPersona({ handle: 'editor' });
  const t = s.rt.createThread({ projectId: 'p1', title: 'MD', personaIds: [a.id, b.id] });
  const [author, editor] = Object.values(s.store.state.sessions).filter((se) => se.threadId === t.id);
  const shown = s.rt.toolsFor(author.id).show_block({
    block: { id: 'rv-md', type: 'review', version: 1, fallback: 'Review doc', format: 'markdown', content: 'Line one.' },
  });
  assert.equal(shown.ok, true, shown.message);
  const r = s.rt.toolsFor(editor.id).review_block({
    blockId: 'rv-md',
    verdict: 'comment',
    comments: [{ line: 1, anchor: 'region 1', region: box, text: 'Not an app.' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /only a comment on an app marks a region; a markdown review’s comment is on a line\./);
});
