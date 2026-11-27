// #1856: the submodules made in an Antigravity agent’s worktree (server/adapters/agent-submodules.mjs), with a fake
// git that keeps what it was asked. The same module against real git is in tests/process/agent-submodules*.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSubmodules } from '../server/adapters/agent-submodules.mjs';
import { tempDir } from './temp-dirs.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

test('#1856 at most 100 submodules are asked for, and each is added with git’s own submodule checkout off', async () => {
  const data = tempDir('pb-subs-');
  const repo = join(data, 'project');
  const dir = join(data, 'worktree');
  mkdirSync(dir);
  const names = Array.from({ length: 103 }, (_, i) => `m${i}`);
  // The person’s checkout holds the first two.
  for (const n of names.slice(0, 2)) mkdirSync(join(repo, n), { recursive: true });
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../server/adapters/agent-worktree.mjs').Git} */
  const git = async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (args[0] === 'config') return ok(names.map((n) => `submodule.${n}.path\n${n}\0`).join(''));
    if (args[0] === 'ls-tree')
      return ok(
        names
          .slice(0, 2)
          .map((n) => `160000 commit ${'a'.repeat(40)}\t${n}\0`)
          .join(''),
      );
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(`${cwd}\n`);
    if (args.includes('worktree')) return ok();
    return { code: 1, stdout: '', stderr: '' };
  };
  assert.deepEqual(await addSubmodules(git, { repo, dir, branch: 'postbox/x' }), []);
  const asked = calls.find((c) => c[1] === 'ls-tree') ?? [];
  assert.deepEqual(asked.slice(5), names.slice(0, 100), 'the first hundred, and no more');
  const adds = calls.filter((c) => c.includes('worktree') && c.includes('add'));
  assert.equal(adds.length, 2);
  // Git’s own would fetch each submodule’s submodules, with the repository’s ssh command.
  for (const add of adds) assert.deepEqual(add.slice(1, 5), ['-c', 'submodule.recurse=false', 'worktree', 'add']);
});
