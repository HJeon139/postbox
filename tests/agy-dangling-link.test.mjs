// A path through a link whose target doesn’t exist yet, a dangling link, is judged by where the link leads, not as
// written (#1134): a write there would create the target, wherever it points, so one outside the agent’s folders asks.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('#1134 a link target with a leading space is read as the file system reads it, not trimmed', () => {
  const { home, ws } = aHome();
  symlinkSync(home, join(ws, ' foo'));
  symlinkSync(' foo/out-space.txt', join(ws, 'sp'));
  // Trimmed, the target would read as ws/foo/out-space.txt, inside; it leads through the link named “ foo”, to home.
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'sp') }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask');
  writeFileSync(join(ws, 'sp'), 'x');
  assert.ok(existsSync(join(home, 'out-space.txt')), 'the write really lands outside');
});

test('#1134 a link target of only spaces names a file, so it’s followed there', () => {
  const { home, ws } = aHome();
  symlinkSync(join(home, 'out-blank.txt'), join(ws, '  '));
  symlinkSync('  ', join(ws, 'bl'));
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'bl') }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask');
  writeFileSync(join(ws, 'bl'), 'x');
  assert.ok(existsSync(join(home, 'out-blank.txt')), 'the write really lands outside');
});

/** Writes a chain of n dangling links, first → … → later.txt, inside ws, and returns the first one’s path. */
function aChain(ws, n) {
  for (let i = 0; i < n - 1; i++) symlinkSync(`c${i + 1}`, join(ws, `c${i}`));
  symlinkSync('later.txt', join(ws, `c${n - 1}`));
  return join(ws, 'c0');
}

test('#1134 a chain of 39 dangling links inside is allowed, and one of 41 asks', () => {
  const inside39 = aHome();
  const opts39 = { mode: 'auto', folders: [inside39.ws], cwd: inside39.ws, home: inside39.home };
  assert.equal(decide('write_to_file', { TargetFile: aChain(inside39.ws, 39) }, opts39).decision, 'allow', '39 links');
  const past = aHome();
  const opts41 = { mode: 'auto', folders: [past.ws], cwd: past.ws, home: past.home };
  assert.equal(decide('write_to_file', { TargetFile: aChain(past.ws, 41) }, opts41).decision, 'ask', '41 links');
});

/** Writes l0 → l1/../l1 → … → gone, inside ws: following each link twice, a walk of it doubles at every level. */
function aDoublingChain(ws, depth) {
  for (let i = 0; i < depth; i++) symlinkSync(`l${i + 1}/../l${i + 1}`, join(ws, `l${i}`));
  symlinkSync('gone', join(ws, `l${depth}`));
  return join(ws, 'l0');
}

test('#1134 links are counted per path, as the kernel counts them, so one that follows too many asks', () => {
  const { home, ws } = aHome();
  // Six levels stay well under the limit on any one branch, and follow more than 100 links in all, past the limit of 40.
  const target = aDoublingChain(ws, 6);
  assert.equal(decide('write_to_file', { TargetFile: target }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask');
});

test('#1134 a path planted to double the walk at every level is judged at once', () => {
  const { home, ws } = aHome();
  const target = aDoublingChain(ws, 14);
  const started = performance.now();
  const { decision } = decide('write_to_file', { TargetFile: target }, { mode: 'auto', folders: [ws], cwd: ws, home });
  const elapsed = performance.now() - started;
  // One count for the whole path takes milliseconds here, and one per branch takes about 9 seconds: 5 leaves room for a busy machine.
  assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
  assert.equal(decision, 'ask');
});

test('#1134 a path that runs out of links gives up whole, whatever it names after the loop', () => {
  const { home, ws } = aHome();
  symlinkSync('loop', join(ws, 'loop'));
  // The kernel fails all of it. Picked up again from “/”, the rest would read as a file in ws.
  const target = `${join(ws, 'loop')}${join(ws, 'new.txt')}`;
  assert.equal(decide('write_to_file', { TargetFile: target }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask');
});
