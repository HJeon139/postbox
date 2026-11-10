// A path through a link whose target doesn’t exist yet, a dangling link, is judged by where the link leads, not as
// written (#1134): a write there would create the target, wherever it points, so one outside the agent’s folders asks.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

function aHome() {
  const home = realpathSync(tempDir('pb-agy-dangling-'));
  const ws = join(home, 'ws');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'a.txt'), 'x');
  return { home, ws };
}
const decide = (name, args, opts) => decideAgyTool({ toolCall: { name, args } }, opts);

test('#1134 a write through a link whose target doesn’t exist yet asks, since it lands outside', () => {
  const { home, ws } = aHome();
  symlinkSync(join(home, '.zshenv_probe'), join(ws, 'dangling'));
  for (const mode of ['acceptEdits', 'auto'])
    assert.equal(decide('write_to_file', { TargetFile: join(ws, 'dangling') }, { mode, folders: [ws], cwd: ws, home }).decision, 'ask', mode);
  assert.equal(decide('write_to_file', { TargetFile: 'dangling' }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask', 'relative');
});

test('#1134 a read through a dangling link asks too', () => {
  const { home, ws } = aHome();
  symlinkSync(join(home, 'notes', 'later.md'), join(ws, 'dangling.md'));
  assert.equal(decide('view_file', { AbsolutePath: join(ws, 'dangling.md') }, { mode: 'ask', folders: [ws], cwd: ws, home }).decision, 'ask');
});

test('#1134 a link in the middle of a path, to a folder outside that doesn’t exist yet, asks', () => {
  const { home, ws } = aHome();
  symlinkSync(join(home, 'later'), join(ws, 'dir-link'));
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'dir-link', 'new.txt') }, { mode: 'acceptEdits', folders: [ws], cwd: ws, home }).decision, 'ask');
});

test('#1134 a chain of dangling links is followed to its end, and a loop of them asks', () => {
  const { home, ws } = aHome();
  symlinkSync(join(ws, 'second'), join(ws, 'first'));
  symlinkSync(join(home, 'outside.txt'), join(ws, 'second'));
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'first') }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask', 'a chain');
  symlinkSync(join(ws, 'loop-b'), join(ws, 'loop-a'));
  symlinkSync(join(ws, 'loop-a'), join(ws, 'loop-b'));
  assert.notEqual(decide('write_to_file', { TargetFile: join(ws, 'loop-a') }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'allow', 'a loop');
});

test('#1134 unchanged: a new file, and a dangling link that stays inside, are still allowed in Accept edits', () => {
  const { home, ws } = aHome();
  const opts = { mode: 'acceptEdits', folders: [ws], cwd: ws, home };
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'new.txt') }, opts).decision, 'allow', 'a new file');
  symlinkSync('later.txt', join(ws, 'inside-link'));
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'inside-link') }, opts).decision, 'allow', 'a link inside');
});

test('#1134 a dangling link whose target runs through another link is judged where that one leads', () => {
  const { home, ws } = aHome();
  mkdirSync(join(home, 'outdir'));
  symlinkSync(join(home, 'outdir'), join(ws, 'alias'));
  // ws/first → ws/alias/out.txt, which doesn’t exist: read as written it’s inside, but it lands in ~/outdir.
  symlinkSync(join(ws, 'alias', 'out.txt'), join(ws, 'first'));
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'first') }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask');
});
