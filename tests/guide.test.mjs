// The agent guide (#63): what a reply contains decides its form, before anything else, and it stays short.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentGuide, guideText } from '../server/adapters/guide.mjs';

test('the guide starts from what a reply contains, not from what the person asked for', () => {
  const g = guideText();
  const first = g.split('\n## ')[0];
  assert.match(first, /^## What your reply contains decides its form/);
  assert.match(first, /whether or not the person asked for a block/);
  for (const [contains, block] of [
    ['Options to pick from', 'a choice'],
    ['Questions for the person', 'a form'],
    ['A draft to approve', 'a review block'],
    ['A job of several steps that takes minutes', 'a progress block'],
  ])
    assert.match(first, new RegExp(`^- ${contains}[^\\n]*→ ${block}`, 'm'), `${contains} → ${block}`);
  // The old wording matched requests (“To ask for a line-by-line review…”), which agents read as “when asked”.
  assert.doesNotMatch(g, /To ask for a/);
});

test('the guide tells agents to report results, and to update an answered block only to ask again (#94)', () => {
  const g = guideText();
  assert.match(g, /Report what you did in your reply, or with update_block on the answered choice, form or confirm with outcome set/);
  assert.match(g, /Update an answered block without outcome only to ask again/);
});

test('the guide stays short: agents follow defaults more than prose', () => {
  // About 8,300 characters before M1 core, which added the limits, palettes and outcome. Cut before adding.
  assert.ok(guideText().length <= 9000, `The guide is ${guideText().length} characters. Keep it under 9,000.`);
  // It’s the same text on every turn.
  const who = { persona: { handle: 'a' }, handles: ['a', 'b'] };
  assert.equal(agentGuide(who), agentGuide(who));
});
