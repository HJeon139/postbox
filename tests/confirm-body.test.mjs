// #852: a confirmed `gh pr|issue … --body-file <path>` posts a file the person never sees in the command itself, so
// the confirm shows that file. readBodyFile reads it only from the agent’s places, through links, as UTF-8 text of
// at most 64 KB, and bodyStillSame tells whether the file is still the one the person read.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BODY_MAX, bodyFileOf, bodyStillSame, readBodyFile } from '../server/confirm-body.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A place the agent may post from, and a folder outside it, both real paths. */
const setupPlaces = () => {
  const root = tempDir('pb-confirm-body-');
  const place = join(root, 'work');
  const outside = join(root, 'elsewhere');
  mkdirSync(place);
  mkdirSync(outside);
  return { place, outside, places: [place] };
};

test('bodyFileOf gives the path after --body-file', () => {
  assert.equal(bodyFileOf('gh pr create --title T --body-file /tmp/x/body.md --repo o/r'), '/tmp/x/body.md');
  assert.equal(bodyFileOf('gh issue comment 5 --body-file=/tmp/x/c.md'), '/tmp/x/c.md');
  assert.equal(bodyFileOf('cd /home/me/p && gh pr edit 5 --body-file "/home/me/p/b c.md"'), '/home/me/p/b c.md');
});

test('bodyFileOf gives null for a command with no body file', () => {
  assert.equal(bodyFileOf('git -C /home/me/p push origin main'), null);
  assert.equal(bodyFileOf('gh pr create --title T --body "inline text"'), null);
});

test('bodyFileOf gives null when --body-file is the last word, with no value', () => {
  assert.equal(bodyFileOf('gh pr create --title T --body-file'), null);
});

test('readBodyFile refuses a relative path', async () => {
  const { place, places } = setupPlaces();
  writeFileSync(join(place, 'b.md'), 'hi');
  const r = await readBodyFile('work/b.md', places);
  assert.equal(r.ok, false);
  assert.match(r.why, /work\/b\.md/);
});

test('readBodyFile refuses a file outside the places', async () => {
  const { outside, places } = setupPlaces();
  const path = join(outside, 'b.md');
  writeFileSync(path, 'secret');
  const r = await readBodyFile(path, places);
  assert.equal(r.ok, false);
  assert.ok(r.why.includes(path), r.why);
});

test('readBodyFile refuses a link inside a place that points outside it', async () => {
  const { place, outside, places } = setupPlaces();
  writeFileSync(join(outside, 'secret.md'), 'secret');
  const link = join(place, 'b.md');
  symlinkSync(join(outside, 'secret.md'), link);
  const r = await readBodyFile(link, places);
  assert.equal(r.ok, false);
  assert.ok(r.why.includes(link), r.why);
});

test('readBodyFile follows a link that stays inside, and gives its real path', async () => {
  const { place, places } = setupPlaces();
  mkdirSync(join(place, 'drafts'));
  writeFileSync(join(place, 'drafts', 'real.md'), 'body');
  const link = join(place, 'b.md');
  symlinkSync(join(place, 'drafts', 'real.md'), link);
  const r = await readBodyFile(link, places);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.file.path, link);
  assert.equal(r.file.real, join(place, 'drafts', 'real.md'));
  assert.equal(r.file.text, 'body');
});

test('readBodyFile refuses a file over 64 KB', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'big.md');
  writeFileSync(path, 'a'.repeat(BODY_MAX + 1));
  const r = await readBodyFile(path, places);
  assert.equal(r.ok, false);
  assert.ok(r.why.includes(path), r.why);
  const exact = join(place, 'exact.md');
  writeFileSync(exact, 'a'.repeat(BODY_MAX));
  assert.equal((await readBodyFile(exact, places)).ok, true, 'exactly 64 KB is allowed');
});

test('readBodyFile refuses a folder', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'dir');
  mkdirSync(path);
  const r = await readBodyFile(path, places);
  assert.equal(r.ok, false);
  assert.ok(r.why.includes(path), r.why);
});

test('readBodyFile refuses a file that isn’t valid UTF-8', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'bin.md');
  writeFileSync(path, Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]));
  const r = await readBodyFile(path, places);
  assert.equal(r.ok, false);
  assert.ok(r.why.includes(path), r.why);
});

test('readBodyFile gives the file’s path, real path, SHA-256, size and text', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'b.md');
  writeFileSync(path, 'Fixes #852\n— done\n');
  const r = await readBodyFile(path, places);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.file, {
    path,
    real: path,
    // printf 'Fixes #852\n— done\n' | sha256sum
    sha256: 'a233af48b39d1b19205e23fe2609a9d59e16dbac38663089fd18f2d9e79e0067',
    size: 20,
    text: 'Fixes #852\n— done\n',
  });
});

test('bodyStillSame is true for a file nobody changed', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'b.md');
  writeFileSync(path, 'body');
  const r = await readBodyFile(path, places);
  assert.equal(await bodyStillSame(r.file), true);
});

test('bodyStillSame is false once the file is edited', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'b.md');
  writeFileSync(path, 'body');
  const r = await readBodyFile(path, places);
  writeFileSync(path, 'other');
  assert.equal(await bodyStillSame(r.file), false);
});

test('bodyStillSame is false once the link points at another file with the same bytes', async () => {
  const { place, outside, places } = setupPlaces();
  writeFileSync(join(place, 'one.md'), 'body');
  writeFileSync(join(outside, 'two.md'), 'body');
  const link = join(place, 'b.md');
  symlinkSync(join(place, 'one.md'), link);
  const r = await readBodyFile(link, places);
  unlinkSync(link);
  symlinkSync(join(outside, 'two.md'), link);
  assert.equal(await bodyStillSame(r.file), false);
});

test('bodyStillSame is false once the file is gone', async () => {
  const { place, places } = setupPlaces();
  const path = join(place, 'b.md');
  writeFileSync(path, 'body');
  const r = await readBodyFile(path, places);
  rmSync(path);
  assert.equal(await bodyStillSame(r.file), false);
});
