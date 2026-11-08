// #547: a project’s folder bounds the file picker and is where its agents start, so creating one takes only a full
// path to a folder that exists, as written but for one / at its end: no empty, . or .. part, no control or hidden
// character, at most 4096 characters. An empty or relative one was resolved against the server’s working folder.
// It’s kept by its real path.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProject } from '../server/projects.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const EMPTY = 'Write the folder’s full path.';
const NOT_TEXT = 'A project’s folder is its full path, as text. Write the folder’s full path.';
const CONTROL = 'A folder’s path can’t contain control characters, such as a new line. Write the folder’s full path.';
const RELATIVE = 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.';
const HIDDEN =
  'A folder’s path can’t contain invisible characters, such as a zero-width space or a bidi control, or a lone surrogate. Write the folder’s full path.';
const PARTS = 'A folder’s path can’t have an empty, . or .. part, such as //, /./ or /../. Write the folder’s full path without them.';
const TOO_LONG = 'A folder’s path is at most 4096 characters. Pick a folder with a shorter path.';
const MISSING = 'That folder doesn’t exist. Pick an existing folder for the project.';

/** Creating a project with this folder is refused with a 422 and this message, and makes no project. */
async function refused(folder, message) {
  const store = new Store(null);
  await assert.rejects(
    () => createProject(store, { name: 'P', folder }),
    (e) => {
      assert.equal(e.status, 422, JSON.stringify(folder));
      assert.equal(e.message, message, JSON.stringify(folder));
      return true;
    },
  );
  assert.deepEqual(Object.keys(store.state.projects), [], `no project for ${JSON.stringify(folder)}`);
}

test('an empty, blank or missing folder is refused, never the server’s working folder', async () => {
  for (const folder of ['', '  ', '\t', undefined, null]) await refused(folder, EMPTY);
});

test('a relative folder is refused, never resolved against the server’s working folder', async () => {
  for (const folder of ['.', '..', 'relative/x', 'server', './server', '~/project', ' /tmp', 'a"<&b']) await refused(folder, RELATIVE);
});

test('a folder with a NUL or another control character is refused', async () => {
  for (const folder of ['/tmp/a\u0000b', '\u0000', '/tmp/a\nb', '/tmp/\u007f', '/tmp/a\u0085b']) await refused(folder, CONTROL);
});

test('a folder that isn’t text is refused, not turned into text', async () => {
  for (const folder of [42, ['/tmp'], { toString: () => '/tmp' }, true]) await refused(folder, NOT_TEXT);
});

test('a folder that isn’t text but would turn into blank text is refused as not text, not as empty', async () => {
  for (const folder of [[], { toString: () => '  ' }, ['  ']]) await refused(folder, NOT_TEXT);
});

test('a folder with a bidi control, a zero-width character or a lone surrogate is refused', async () => {
  for (const folder of ['/tmp/a\u202eb', '/tmp/\u2066x\u2069', '/tmp/a\u200bb', '/tmp/a\u200db', '\ufeff/tmp', '/tmp/a\ud800b', '/tmp/a\udc00'])
    await refused(folder, HIDDEN);
});

test('a folder with a . or .. part or a // is refused, never normalized', async () => {
  for (const folder of ['/tmp/x/../../etc', '/tmp/..', '/..', '/.', '/tmp/./x', '/tmp/.', '/tmp/./', '/tmp/../', '//tmp', '/tmp//x', '/tmp//', '//', '///'])
    await refused(folder, PARTS);
});

test('a full path with one / at its end, as tab completion writes it, makes the project at the folder’s real path', async () => {
  const folder = tempDir('pb-projects-');
  const store = new Store(null);
  const p = await createProject(store, { name: 'Tabbed', folder: `${folder}/` });
  assert.deepEqual(store.state.projects[p.id], { id: p.id, name: 'Tabbed', folder: realpathSync(folder) });
});

test('a folder path over 4096 characters is refused, and one of 4096 is only looked for', async () => {
  await refused(`/${'a'.repeat(4096)}`, TOO_LONG);
  await refused(`/${'a'.repeat(4095)}`, MISSING);
});

test('/ itself is a full path, and makes a project there', async () => {
  const store = new Store(null);
  const p = await createProject(store, { name: 'Root', folder: '/' });
  assert.deepEqual(store.state.projects[p.id], { id: p.id, name: 'Root', folder: '/' });
});

test('a full path to a folder that exists makes the project there, quotes and brackets in its name included', async () => {
  const folder = join(realpathSync(tempDir('pb-projects-')), 'a"<&b');
  mkdirSync(folder);
  const store = new Store(null);
  const p = await createProject(store, { name: 'Mine', folder });
  assert.equal(p.folder, folder);
  assert.deepEqual(store.state.projects[p.id], { id: p.id, name: 'Mine', folder });
});

test('a full path to a folder that doesn’t exist is refused', async () => {
  const store = new Store(null);
  const folder = join(tempDir('pb-projects-'), 'gone');
  await assert.rejects(() => createProject(store, { folder }), { status: 422, message: MISSING });
  assert.deepEqual(Object.keys(store.state.projects), []);
});

test('a full path through a symbolic link is kept as the folder’s real path', async () => {
  const root = realpathSync(tempDir('pb-projects-'));
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'link'));
  const store = new Store(null);
  const p = await createProject(store, { folder: join(root, 'link') });
  assert.deepEqual(store.state.projects[p.id], { id: p.id, name: 'New project', folder: join(root, 'real') });
});

test('a full path through a symbolic link to a file, or a dangling one, is refused', async () => {
  const root = realpathSync(tempDir('pb-projects-'));
  writeFileSync(join(root, 'file.txt'), 'x');
  symlinkSync(join(root, 'file.txt'), join(root, 'to-file'));
  symlinkSync(join(root, 'gone'), join(root, 'dangling'));
  for (const folder of [join(root, 'to-file'), join(root, 'dangling')]) await refused(folder, MISSING);
});

test('a full path to a file, not a folder, is refused', async () => {
  const root = tempDir('pb-projects-');
  writeFileSync(join(root, 'file.txt'), 'x');
  const store = new Store(null);
  await assert.rejects(() => createProject(store, { folder: join(root, 'file.txt') }), { status: 422, message: MISSING });
  assert.deepEqual(Object.keys(store.state.projects), []);
});
