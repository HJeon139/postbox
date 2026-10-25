import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpec, specsToRepeat } from '../tools/repeat-specs.mjs';

const PR = ['tests/browser/postbox.mjs', 'tests/browser/menus.spec.mjs', 'tests/browser/pane.spec.mjs', 'app/js/agents.mjs', 'tests/permissions.test.mjs'];

test('the ten-times job repeats the specs a pull request adds or edits, not those it reaches through a helper', () => {
  assert.deepEqual(specsToRepeat(PR, null), ['tests/browser/menus.spec.mjs', 'tests/browser/pane.spec.mjs']);
});

test('on a later push it repeats only the specs that push changed', () => {
  const before = (/** @type {string[]} */ push) => ({ push, pr: PR });
  assert.deepEqual(specsToRepeat(PR, before(['tests/browser/pane.spec.mjs', 'app/js/agents.mjs'])), ['tests/browser/pane.spec.mjs']);
  assert.deepEqual(specsToRepeat(PR, before(['app/js/agents.mjs'])), [], 'a push that changes no spec repeats none');
  // A merge of main brings specs main changed, which the pull request didn’t.
  assert.deepEqual(specsToRepeat(PR, before(['tests/browser/work-pane.spec.mjs'])), []);
});

test('a later push repeats a spec that wasn’t in the pull request at the push before, though it didn’t change it', () => {
  // Retargeted from a stacked branch to main: the specs the lower branch added are the pull request’s now.
  const was = { push: ['app/js/agents.mjs'], pr: ['tests/browser/pane.spec.mjs', 'app/js/agents.mjs'] };
  assert.deepEqual(specsToRepeat(PR, was), ['tests/browser/menus.spec.mjs']);
});

test('a spec is a .spec.mjs file under tests/browser, with a name a shell takes as it is', () => {
  assert.ok(isSpec('tests/browser/menus.spec.mjs'));
  assert.ok(isSpec('tests/browser/pane/handle.spec.mjs'));
  for (const f of [
    'tests/browser/postbox.mjs',
    'tests/menus.test.mjs',
    'tests/browser/a.spec.mjs.orig',
    'tests/browser/*.spec.mjs',
    'tests/browser/a b.spec.mjs',
    'tests/browser/$(x).spec.mjs',
  ])
    assert.ok(!isSpec(f), f);
});
