// The staging worktrees a killed runner left registered (#766; tools/uat/hosts-stage.mjs, forgetStaleStaged): the
// next staging forgets only its own kind, a staged-XXXXXX folder of a run under the same runs folder that’s gone,
// and never runs `git worktree prune`, which would forget every worktree of the checkout whose folder is missing,
// such as one on a drive that isn’t mounted.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stageOlder } from '../tools/uat/hosts-stage.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A runs folder holding this run’s folder, and an earlier run’s staging worktree that’s still there. */
function runs() {
  const root = tempDir('pb-runs-');
  mkdirSync(join(root, 'new'));
  const live = join(root, 'live', 'staged-ZzZ999');
  mkdirSync(live, { recursive: true });
  return { root, data: join(root, 'new', 'data'), live, old: join(root, 'old', 'staged-AbC123') };
}

/** `git worktree list --porcelain -z` as git writes it: each worktree’s fields, NUL-ended, and a NUL after each. */
const porcelain = (trees) => trees.map((t) => `${t.join('\0')}\0\0`).join('');

/** git as the staging runs it, recording each call; list answers with `listed`, or fails with `listCode`. */
const fakeGit =
  (calls, listed, listCode = 0) =>
  (args) => {
    calls.push(args);
    if (args[1] === 'list') return { code: listCode, stdout: listCode ? '' : listed, stderr: listCode ? 'fatal: not a git repository' : '' };
    return { code: 0, stdout: '', stderr: '' };
  };

const load = async () => ({ installHost: async (o) => ({ installed: true, version: o.version }) });
const host = { id: 'ho_1', name: 'host-a.example.com', settings: {} };

test('#766 staging forgets only a gone staged worktree of an earlier run, never prunes, and never names another worktree', async () => {
  const r = runs();
  const listed = porcelain([
    ['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
    [
      'worktree /mnt/usb/feature',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature',
      'prunable gitdir file points to non-existent location',
    ],
    [`worktree ${r.old}`, 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable gitdir file points to non-existent location'],
    [`worktree ${r.live}`, 'HEAD 4444444444444444444444444444444444444444', 'detached'],
    [
      `worktree ${join(r.root, 'old', 'work')}`,
      'HEAD 6666666666666666666666666666666666666666',
      'detached',
      'prunable gitdir file points to non-existent location',
    ],
    ['worktree /elsewhere/staged-QqQ111', 'HEAD 5555555555555555555555555555555555555555', 'detached', 'prunable gitdir file points to non-existent location'],
  ]);
  const calls = [];
  await stageOlder({ root: '/repo', tag: 'v1.16.1', version: '1.16.1', data: r.data, label: 'host1', host }, { run: fakeGit(calls, listed), load });
  assert.equal(
    calls.some((c) => c.includes('prune')),
    false,
    'no `git worktree prune`',
  );
  const add = calls.findIndex((c) => c[1] === 'add');
  const tree = calls[add][3];
  const removes = calls.slice(0, add).filter((c) => c[1] === 'remove');
  assert.deepEqual(removes, [['worktree', 'remove', '--force', r.old]], 'exactly the old run’s, before the add');
  const named = calls.flat().filter((a) => a.startsWith('/') && a !== r.old && a !== tree);
  assert.deepEqual(named, [], 'no other worktree is named: not the main one, the unmounted one, a run’s other folder, the live one or one elsewhere');
});

test('#766 a worktree list that fails skips the forgetting, and the staging still goes on', async () => {
  const r = runs();
  const calls = [];
  const got = await stageOlder(
    { root: '/repo', tag: 'v1.16.1', version: '1.16.1', data: r.data, label: 'host1', host },
    { run: fakeGit(calls, '', 128), load },
  );
  assert.deepEqual(got, { installed: true, version: '1.16.1' });
  const add = calls.findIndex((c) => c[1] === 'add');
  assert.ok(add > 0, 'the add still runs');
  assert.deepEqual(
    calls.slice(0, add).map((c) => c[1]),
    ['list'],
    'nothing removed before the add',
  );
});

test('#766 staging reached through a link to the runs folder forgets a gone worktree git lists by its real path', async () => {
  const r = runs();
  const link = join(tempDir('pb-runs-link-'), 'runs');
  symlinkSync(r.root, link);
  const old = join(realpathSync(r.root), 'old', 'staged-AbC123');
  const listed = porcelain([
    [`worktree ${old}`, 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable gitdir file points to non-existent location'],
  ]);
  const calls = [];
  const data = join(link, 'new', 'data');
  await stageOlder({ root: '/repo', tag: 'v1.16.1', version: '1.16.1', data, label: 'host1', host }, { run: fakeGit(calls, listed), load });
  const add = calls.findIndex((c) => c[1] === 'add');
  const removes = calls.slice(0, add).filter((c) => c[1] === 'remove');
  assert.deepEqual(removes, [['worktree', 'remove', '--force', old]], 'the old run’s, by its real path, before the add');
});
