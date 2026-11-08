// A command that pushes several times: one push for each that landed (#978).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandFacts } from '../shared/work.mjs';
import { fakeGit, REC, replayLedger } from './work-replay.mjs';

/** v with every string in it, at any depth, put through f. */
function mapStrings(v, f) {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
}

// git push’s own output, from a loop of pushes on git 2.47: three branches, one more commit, then one push refused.
const LOOP_OUT = [
  'To ../remote.git\n * [new branch]      a -> a',
  'To ../remote.git\n * [new branch]      b -> b',
  'To ../remote.git\n * [new branch]      c -> c',
  'To ../remote.git\n   04df91d..99ea717  HEAD -> a',
  "To ../remote.git\n ! [rejected]        a -> a (non-fast-forward)\nerror: failed to push some refs to '../remote.git'",
].join('\n');

test('a command that pushes several times has one push for each that landed (#978)', () => {
  const loop = commandFacts('for b in a b c; do git push ../remote.git $b; done; git push ../remote.git HEAD:a; git push ../remote.git a', LOOP_OUT);
  assert.deepEqual(loop.pushes, [
    { remote: '../remote.git', refs: ['a → a'], branch: 'a' },
    { remote: '../remote.git', refs: ['b → b'], branch: 'b' },
    { remote: '../remote.git', refs: ['c → c'], branch: 'c' },
    { remote: '../remote.git', refs: ['HEAD → a'], branch: 'a' },
  ]);
  const twoRemotes = commandFacts('git push one && git push two', 'To one.git\n * [new branch] x -> x\nTo two.git\n * [new branch] x -> x\n');
  assert.deepEqual(
    twoRemotes.pushes.map((p) => p.remote),
    ['one.git', 'two.git'],
  );
  assert.deepEqual(
    commandFacts('git push', 'Everything up-to-date\n').pushes,
    [{ remote: null, refs: [], branch: '' }],
    'a push with nothing to say is still the one push, as before',
  );
  assert.deepEqual(
    commandFacts('git push', 'To r.git\n ! [rejected]        a -> a (fetch first)\n').pushes,
    [{ remote: 'r.git', refs: [], branch: '' }],
    'nothing landed: the one push, with its remote',
  );
  assert.deepEqual(commandFacts('git status', LOOP_OUT).pushes, [], 'output alone isn’t a push');
  // A tag isn’t a branch: a push of one names none (git 2.47’s output), and a push of both names the branch, here
  // with the tag listed first.
  assert.deepEqual(commandFacts('git push ../r.git v1.2', 'To ../r.git\n * [new tag]         v1.2 -> v1.2\n').pushes, [
    { remote: '../r.git', refs: ['v1.2 → v1.2'], branch: '' },
  ]);
  const both = 'To ../r.git\n * [new tag]         v1.2 -> v1.3\n * [new branch]      HEAD -> x\n';
  assert.equal(commandFacts('git push ../r.git HEAD:refs/heads/x refs/tags/v1.2:refs/tags/v1.3', both).pushes[0].branch, 'x');
  const full = 'To ../r.git\n   04df91d..99ea717  v1.2 -> refs/tags/v1.2\n';
  assert.equal(commandFacts('git push ../r.git v1.2:refs/tags/v1.2', full).pushes[0].branch, '', 'a tag named in full');
});

const RECORDED_FILES = { '/workspace/rec/notes.txt': 'alpha\nBETA\ngamma\n', '/workspace/rec/hello.md': '# Hello' };

test('the recorded push, made a loop of pushes: the ledger has a push for each, on its own branch (#978)', async () => {
  // The recorded turn, its push command’s line and output swapped for the loop’s; Claude Code’s gitOperation still
  // names one push, of feature.
  const loop = (s) =>
    s
      .replaceAll(' && git push -u origin feature', '; for b in a b c; do git push ../remote.git $b; done; git push ../remote.git HEAD:a')
      .replaceAll('To /workspace/remote.git\n * [new branch]      feature -> feature', LOOP_OUT);
  const edit = (e) => mapStrings(e, loop);
  const { of } = await replayLedger('ledger-push', {
    files: RECORDED_FILES,
    git: fakeGit(REC),
    edit,
  });
  assert.deepEqual(
    of('push').map((p) => [p.branch, p.remote, p.refs]),
    [
      ['a', '../remote.git', ['a → a']],
      ['b', '../remote.git', ['b → b']],
      ['c', '../remote.git', ['c → c']],
      ['a', '../remote.git', ['HEAD → a']],
    ],
  );
  assert.equal(new Set(of('push').map((p) => p.commandId)).size, 1, 'all from the one command');
});

test('the recorded push, its output saying nothing of what it sent: the one push, on the branch Claude Code named', async () => {
  const quiet = (s) => s.replaceAll('To /workspace/remote.git\n * [new branch]      feature -> feature', 'Everything up-to-date');
  const { of } = await replayLedger('ledger-push', {
    files: RECORDED_FILES,
    git: fakeGit(REC),
    edit: (e) => mapStrings(e, quiet),
  });
  assert.deepEqual(
    of('push').map((p) => [p.branch, p.remote, p.refs]),
    [['feature', null, []]],
  );
  // A tag pushed: the push is on the branch Claude Code named, not on the tag.
  const tag = (s) => s.replaceAll('* [new branch]      feature -> feature', '* [new tag]         v1.2 -> v1.2');
  const tagged = await replayLedger('ledger-push', { files: RECORDED_FILES, git: fakeGit(REC), edit: (e) => mapStrings(e, tag) });
  assert.deepEqual(
    tagged.of('push').map((p) => [p.branch, p.refs]),
    [['feature', ['v1.2 → v1.2']]],
  );
  // A push the command line doesn’t show as one (here a config flag before it): Claude Code’s report is the push.
  const flagged = (s) => s.replaceAll('git push -u origin feature', 'git -c push.default=current push -u origin feature');
  const reported = await replayLedger('ledger-push', {
    files: RECORDED_FILES,
    git: fakeGit(REC),
    edit: (e) => mapStrings(e, flagged),
  });
  assert.deepEqual(
    reported.of('push').map((p) => [p.branch, p.remote]),
    [['feature', null]],
  );
});

// ── Where it stands, and the totals ─────────────────────────────────────────────────────
