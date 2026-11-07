// #780: a host call's route (toolRoute). Only a show_block or update_block that carries a review's files waits for
// Postbox's answer; every other call, a review without files included, keeps its tool's route, so ordinary blocks
// from a host still return at once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_ROUTES, toolRoute } from '../shared/remote-protocol.mjs';

const review = (extra = {}) => ({ block: { id: 'r', type: 'review', version: 1, format: 'markdown', content: 'x', fallback: 'x', ...extra } });

test('#780 a review without files, and any other block, stays queued; one with files is asked', () => {
  assert.equal(toolRoute('show_block', review()), 'queue', 'a review without files');
  assert.equal(toolRoute('update_block', review()), 'queue');
  assert.equal(toolRoute('show_block', { block: { id: 'c', type: 'choice', version: 1, fallback: 'x', options: [] } }), 'queue');
  assert.equal(toolRoute('show_block', review({ files: undefined })), 'queue', 'files named but undefined');
  assert.equal(toolRoute('show_block', { block: null }), 'queue');
  assert.equal(toolRoute('show_block', {}), 'queue');
  assert.equal(toolRoute('show_block', review({ files: [{ path: 'a.png' }] })), 'ask');
  assert.equal(toolRoute('update_block', review({ files: [] })), 'ask', 'an empty list still clears the files, so it waits');
});

test('#780 every other tool keeps its route, with or without files in its arguments', () => {
  for (const name of Object.keys(TOOL_ROUTES)) {
    if (name === 'show_block' || name === 'update_block') continue;
    assert.equal(toolRoute(name, review({ files: [{ path: 'a.png' }] })), TOOL_ROUTES[name], name);
  }
});
