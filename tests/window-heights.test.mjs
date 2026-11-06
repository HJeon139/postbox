import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeights, Fenwick } from '../app/js/window-heights.mjs';

test('a Fenwick tree grown by push sums any span as a plain array would', () => {
  const values = [];
  const f = new Fenwick();
  for (let i = 0; i < 300; i++) {
    const v = (i * 37) % 101;
    values.push(v);
    f.push(v);
  }
  for (const [i, v] of [
    [0, 5],
    [17, 0],
    [299, 44],
    [128, 9],
  ]) {
    values[i] = v;
    f.set(i, v);
  }
  const plain = (a, b) => values.slice(a, b).reduce((s, x) => s + x, 0);
  for (const [a, b] of [
    [0, 300],
    [0, 1],
    [1, 2],
    [17, 129],
    [128, 300],
    [64, 64],
    [255, 257],
  ])
    assert.equal(f.sum(a, b), plain(a, b), `${a}..${b}`);
});

test('an unmeasured span is its kinds’ counts times their estimates; a measured item counts as measured', () => {
  const h = createHeights({ agent: 100, user: 40 });
  for (const k of ['agent', 'user', 'agent', 'block', 'agent']) h.push(k);
  assert.equal(h.span(0, 5), 100 + 40 + 100 + 80 + 100, 'seeds, and the fallback for a kind with none');
  h.measure(1, 52);
  assert.equal(h.span(0, 2), 100 + 52);
  assert.equal(h.span(1, 2), 52);
});

test('a kind’s estimate is the median of its first measurements, and a remeasure doesn’t count again', () => {
  const h = createHeights({ agent: 100 });
  for (let i = 0; i < 4; i++) h.push('agent');
  h.measure(0, 10);
  h.measure(1, 30);
  h.measure(2, 500);
  assert.equal(h.estimate('agent'), 30);
  h.measure(2, 500);
  h.measure(2, 500);
  assert.equal(h.estimate('agent'), 30, 'remeasuring item 2 twice more doesn’t move the median');
  assert.equal(h.span(3, 4), 30, 'the one left unmeasured takes the median');
});

test('a measurement that moves its kind’s estimate updates only its own entries, not every unmeasured item (#866)', () => {
  const h = createHeights({ agent: 100 });
  for (let i = 0; i < 2000; i++) h.push('agent');
  const before = h.updates;
  h.measure(7, 300);
  assert.equal(h.estimate('agent'), 300);
  assert.equal(h.updates - before, 2, 'one measured entry and one unmeasured mark, whatever the room’s size');
  assert.equal(h.span(0, 2000), 2000 * 300);
});

test('a stub that takes a moved item’s place changes kind there, and forget() keeps estimates but drops measurements', () => {
  const h = createHeights({ block: 200, sys: 20 });
  h.push('block');
  h.push('agent');
  h.measure(0, 180);
  h.retype(0, 'sys');
  assert.equal(h.span(0, 1), 20);
  h.measure(1, 64);
  h.forget();
  assert.equal(h.span(1, 2), 64, 'the agent kind’s median stays its estimate');
  assert.equal(h.span(0, 1), 20);
});
