import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Costs } from '../app/js/window-cost.mjs';

test('an item not yet counted costs its kind’s seed, and a table more than a line of text', () => {
  const c = new Costs();
  assert.ok(c.of('a', 'block:table') > c.of('b', 'user'));
  assert.equal(c.of('c', 'block:somethingnew'), c.of('d', 'block'));
});

test('a counted item costs its count, and its kind’s estimate becomes the mean of the counts', () => {
  const c = new Costs();
  c.count('a', 'agent', 10);
  c.count('b', 'agent', 30);
  assert.equal(c.of('a', 'agent'), 10);
  assert.equal(c.of('z', 'agent'), 20);
});

test('counting an item again replaces its count rather than adding a second one', () => {
  const c = new Costs();
  c.count('a', 'agent', 10);
  c.count('a', 'agent', 50);
  assert.equal(c.of('a', 'agent'), 50);
  assert.equal(c.of('z', 'agent'), 50);
});

test('a kind named like an object’s own property gets the unknown estimate, not a function', () => {
  const c = new Costs();
  assert.equal(typeof c.of('a', 'constructor'), 'number');
});
