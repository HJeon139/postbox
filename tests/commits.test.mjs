import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInfo } from '../server/build-info.mjs';
import { bumpOf, changelogSection, nextVersion, parseCommit, withoutReverted } from '../tools/commits.mjs';

test('a conventional header is read, with its type, scope and whether it breaks anything', () => {
  assert.deepEqual(parseCommit('feat(rail): show the build’s version under Personas'), {
    ok: true,
    type: 'feat',
    scope: 'rail',
    breaking: false,
    subject: 'show the build’s version under Personas',
  });
  assert.equal(parseCommit('fix!: personas move to the home folder').breaking, true);
  assert.equal(parseCommit('refactor: one pane system\n\nBREAKING CHANGE: the work route is gone').breaking, true);
});

test('a header that isn’t conventional is refused, with what to write instead', () => {
  for (const bad of [
    'Show image attachments as thumbnails',
    'feature: x',
    'fix:no space',
    'Fix: capitalized type',
    `feat: ${'x'.repeat(100)}`,
    'fix: x\nno blank line',
  ])
    assert.equal(parseCommit(bad).ok, false, bad);
  assert.match(parseCommit('Show image attachments').error, /type\(scope\): what changed/);
});

test('merges, release commits and git reverts are allowed, and don’t change the version on their own', () => {
  for (const m of ['Merge pull request #148 from HJeon139/feat/codex-backend', "Merge branch 'main' into x", 'chore(release): v0.3.0', 'Revert "feat: x"']) {
    assert.equal(parseCommit(m).ok, true, m);
    assert.equal(bumpOf(m), null, m);
  }
});

test('the version moves by the largest change: breaking is major, a feature minor, a fix patch', () => {
  assert.equal(nextVersion('0.2.0', ['fix: a', 'docs: b']), '0.2.1');
  assert.equal(nextVersion('0.2.1', ['fix: a', 'feat: b']), '0.3.0');
  assert.equal(nextVersion('0.3.0', ['feat: a', 'fix!: b']), '1.0.0');
  assert.equal(nextVersion('1.4.2', ['perf: faster']), '1.4.3');
  assert.equal(nextVersion('1.4.2', ['docs: a', 'test: b', 'chore(release): v1.4.2']), null);
  assert.throws(() => nextVersion('v1', ['fix: a']));
});

test('the changelog groups breaking changes, features and fixes', () => {
  const s = changelogSection('0.3.0', '2026-10-23', ['feat(rail): version under Personas', 'fix: a bug', 'docs: words', 'feat!: big change']);
  assert.match(s, /^## 0\.3\.0 \(2026-10-23\)/);
  assert.match(s, /### Breaking changes\n\n- big change/);
  assert.match(s, /### Features\n\n- \*\*rail:\*\* version under Personas/);
  assert.match(s, /### Fixes\n\n- a bug/);
  assert.doesNotMatch(s, /words/);
});

test('a commit and the git revert of it, both since the last release, leave the changelog and the version alone', () => {
  const x = 'a'.repeat(40);
  const y = 'b'.repeat(40);
  const z = 'c'.repeat(40);
  // As git log gives them, newest first.
  const log = [
    { sha: z, message: `Revert "docs(store): a power cut can lose a second"\n\nThis reverts commit ${x}.` },
    { sha: y, message: 'feat(rail): version under Personas' },
    { sha: x, message: 'docs(store): a power cut can lose a second\n\nBREAKING CHANGE: a power cut can lose a second' },
  ];
  const kept = withoutReverted(log);
  assert.deepEqual(kept, ['feat(rail): version under Personas']);
  assert.equal(nextVersion('0.3.0', kept), '0.4.0', 'not major: the breaking commit was reverted');
  assert.doesNotMatch(changelogSection('0.4.0', '2026-10-29', kept), /Breaking|power cut|Revert/);
  // A revert of a commit an earlier release holds stays: that release’s changelog named it.
  assert.deepEqual(
    withoutReverted(log.slice(0, 2)),
    log.slice(0, 2).map((c) => c.message),
  );
  // Reverting the revert brings the commit back: the newest pair goes, and the commit stays.
  const w = 'd'.repeat(40);
  const again = [{ sha: w, message: `Revert "Revert "docs(store): a power cut can lose a second""\n\nThis reverts commit ${z}.` }, ...log];
  assert.deepEqual(withoutReverted(again), [log[1].message, log[2].message]);
});

test('the build comes from package.json and the commit Postbox runs from', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-build-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}');
    mkdirSync(join(root, 'server'));
    const version = '1.2.3';
    const noGit = () => {
      throw new Error('not a git checkout');
    };
    assert.deepEqual(buildInfo({ root, env: { POSTBOX_COMMIT: 'ABCDEF1234567' }, git: () => 'unused' }), { version, commit: 'abcdef1' });
    // A clone: git’s top is Postbox’s own folder.
    assert.deepEqual(buildInfo({ root, env: {}, git: () => `${root}\nfedcba9\n` }), { version, commit: 'fedcba9' });
    assert.deepEqual(buildInfo({ root, env: {}, git: noGit }), { version, commit: null });
    // An installed copy (#157): the commit npm pack wrote, even inside someone else’s repository.
    writeFileSync(join(root, 'server', 'build-commit.txt'), '1234abc\n');
    assert.deepEqual(buildInfo({ root, env: {}, git: noGit }), { version, commit: '1234abc' });
    assert.deepEqual(buildInfo({ root, env: {}, git: () => `${tmpdir()}\n9999999\n` }), { version, commit: '1234abc' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
