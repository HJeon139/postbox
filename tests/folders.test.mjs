// A project’s folder as the folder picker lists it (server/folders.mjs): each entry’s name as it is on disk, its real
// path, and the name as the picker shows it, with each character that would hide or reorder it marked (#1052).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { listFolder, markedName } from '../server/folders.mjs';
import { FINE, HOSTILE } from './hidden-chars-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

test('#1052 a name that hides or reorders text is shown with each such character marked', () => {
  assert.deepEqual(
    Object.entries(HOSTILE).map(([what, c]) => [what, markedName(`a${c}${c}b`)]),
    Object.keys(HOSTILE).map((what) => [what, 'a\uFFFD\uFFFDb']),
  );
  assert.equal(markedName('😀'), '😀', 'a whole pair is one character, shown as it is');
  for (const s of FINE) assert.equal(markedName(s), s);
});

test('#1052 the picker’s list keeps each file’s real name and path, and shows the name marked', async () => {
  const root = tempDir('pb-folders-');
  await mkdir(join(root, 'in\u2066side'));
  await writeFile(join(root, 'in\u2066side', 'a\u202Eb.txt'), 'x');
  await writeFile(join(root, 'plain.txt'), 'x');
  const top = await listFolder({ folder: root }, '');
  assert.deepEqual(
    top.entries.map((e) => [e.name, e.path, e.shown]),
    [
      ['in\u2066side', 'in\u2066side', 'in\uFFFDside'],
      ['plain.txt', 'plain.txt', 'plain.txt'],
    ],
  );
  assert.equal(top.shownPath, '');
  const inner = await listFolder({ folder: root }, 'in\u2066side');
  assert.deepEqual(
    inner.entries.map((e) => [e.name, e.path, e.shown]),
    [['a\u202Eb.txt', join('in\u2066side', 'a\u202Eb.txt'), 'a\uFFFDb.txt']],
  );
  assert.deepEqual([inner.path, inner.shownPath], ['in\u2066side', 'in\uFFFDside'], 'the folder it’s in, as the picker heads it');
});
