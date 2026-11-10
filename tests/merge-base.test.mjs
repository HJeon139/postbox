// tools/merge-base.mjs with a fake git (#786): which refs a lint compares with, that a missing one is dropped, and that
// every one left goes to a single git merge-base, which gives the newest base. The real git runs in
// tests/process/lint-ternary.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseRefs, mergeBase } from '../tools/merge-base.mjs';

/** A fake git that knows the refs given, and records each call. @param {string[]} refs */
function fakeGit(refs) {
  /** @type {string[][]} */
  const calls = [];
  const git = (/** @type {string[]} */ args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      if (refs.includes(args.at(-1)?.replace(/\^\{commit\}$/, '') ?? '')) return 'f'.repeat(40);
      throw new Error('no such ref');
    }
    if (args[0] === 'merge-base') return 'abc1234500000000000000000000000000000000\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

test('merge-base: the candidates are the ref given, else origin/$BASE_REF alone, else origin/main and upstream/main', () => {
  assert.deepEqual(baseRefs('v1', { BASE_REF: 'dev' }), ['v1']);
  assert.deepEqual(baseRefs(undefined, { BASE_REF: 'dev' }), ['origin/dev'], 'CI’s BASE_REF ignores upstream');
  assert.deepEqual(baseRefs(undefined, { BASE_REF: '' }), ['origin/main', 'upstream/main']);
  assert.deepEqual(baseRefs(undefined, {}), ['origin/main', 'upstream/main']);
});

test('merge-base: every existing ref goes to one git merge-base with HEAD', () => {
  const { git, calls } = fakeGit(['origin/main', 'upstream/main']);
  assert.deepEqual(mergeBase(git, ['origin/main', 'upstream/main']), {
    at: 'abc1234500000000000000000000000000000000',
    refs: ['origin/main', 'upstream/main'],
  });
  assert.deepEqual(
    calls.filter((args) => args[0] === 'merge-base'),
    [['merge-base', 'HEAD', 'origin/main', 'upstream/main']],
  );
});

test('merge-base: a missing ref is dropped, and with none left there is no base and no merge-base call', () => {
  const origin = fakeGit(['origin/main']);
  assert.deepEqual(mergeBase(origin.git, ['origin/main', 'upstream/main']).refs, ['origin/main']);
  assert.deepEqual(origin.calls.at(-1), ['merge-base', 'HEAD', 'origin/main']);
  const none = fakeGit([]);
  assert.deepEqual(mergeBase(none.git, ['origin/main', 'upstream/main']), { at: '', refs: [] });
  assert.equal(none.calls.filter((args) => args[0] === 'merge-base').length, 0);
});

test('merge-base: refs with no history in common give no base', () => {
  const git = (/** @type {string[]} */ args) => {
    if (args[0] === 'rev-parse') return 'f'.repeat(40);
    throw new Error('exit 1');
  };
  assert.deepEqual(mergeBase(git, ['origin/main']), { at: '', refs: ['origin/main'] });
});
