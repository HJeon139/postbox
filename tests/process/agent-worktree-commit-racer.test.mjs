// #1844: the commit at the end of an Antigravity turn (#1709) with a real process the agent left running, which keeps
// staging a nested repository in the worktree’s own index and taking it out again while Postbox commits, turn after
// turn. The commit is built from Postbox’s copy of the index, so nothing it stages reaches the commit, and git never
// starts inside that repository. Against real git, in the shared temp home.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { git, home, project } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };
/** Turns committed while the process runs: enough that one landing between the last check and the add is likely. */
const TURNS = 40;

/** A loop in its own process that stages `sub` as a gitlink in the worktree’s index and takes it out, until killed. */
const RACER = `
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const [dir, sha, count] = process.argv.slice(1);
const git = (args) => { try { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); return true; } catch { return false; } };
for (let n = 1; ; n++) {
  // Counted whether git took it or found the index locked by Postbox’s own git: either way, the process ran.
  git(['update-index', '--add', '--cacheinfo', '160000,' + sha + ',sub']);
  writeFileSync(count, String(n));
  git(['update-index', '--force-remove', 'sub']);
}
`;

test('#1844 a process left running that keeps staging a nested repository never has git run inside it, turn after turn', async (t) => {
  const { project: p, workRoot } = await project('racer');
  const dir = await agentWorktree(agent, p, workRoot);
  const marker = join(home, 'racer', 'ran');
  writeFileSync(join(dir, '.gitignore'), 'sub/\n');
  writeFileSync(join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
  const sub = join(dir, 'sub');
  await mkdir(sub, { recursive: true });
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, '.gitattributes'), 'f filter=x\n');
  writeFileSync(join(sub, 'f'), 'one\n');
  git(sub, ['add', 'f', '.gitattributes']);
  git(sub, ['commit', '-qm', 'one']);
  writeFileSync(join(sub, '.git', 'config'), `${readFileSync(join(sub, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = "touch ${marker}; cat"\n`);
  writeFileSync(join(sub, 'f'), 'two\n');
  const count = join(home, 'racer', 'staged');
  const racer = spawn(process.execPath, ['-e', RACER, dir, git(sub, ['rev-parse', 'HEAD']).trim(), count], { stdio: 'ignore' });
  t.after(() => racer.kill('SIGKILL'));
  // A process takes a while to start: begin the turns only once it has staged once, or a fast run commits all of them first.
  for (const end = Date.now() + 10_000; !existsSync(count); ) {
    if (Date.now() > end) assert.fail('the process never started staging');
    await new Promise((r) => setTimeout(r, 10));
  }
  let committed = 0;
  for (let i = 0; i < TURNS; i++) {
    await writeFile(join(dir, 'agent.txt'), `the agent’s work, turn ${i}\n`);
    if (await commitTurn(dir, agent, p, workRoot, { log: () => {} })) committed++;
  }
  racer.kill('SIGKILL');
  assert.ok(Number(existsSync(count) ? readFileSync(count, 'utf8') : 0) > 0, 'the process kept staging the nested repository while Postbox committed');
  assert.equal(existsSync(marker), false, 'git never ran inside the nested repository');
  assert.ok(committed > 0, 'the agent’s work was committed while the process ran');
  assert.doesNotMatch(git(p.folder, ['ls-tree', '-r', `postbox/pr_racer-gem-pe_a`]), /^160000 /m, 'no nested repository on the agent’s branch');
});
