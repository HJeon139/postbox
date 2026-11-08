// #990: a persona’s folder (its sheet’s Folder, “Where it works”) is where its agent starts, with shell and edit
// access, so it passes the check a project’s folder does (#547, server/folder-path.mjs): a full path, as text, with no
// control or hidden character and no empty, . or .. part, as written but for one / at its end. It isn’t made to
// exist: the agent’s folder is made at its first turn. Empty still means the project’s folder, or one of its own. A
// relative one was made under the folder Postbox was started from, and a folder stored before this is refused at the
// agent’s next turn, never made.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { agentFolder } from '../server/adapters/folder.mjs';
import { Runtime } from '../server/runtime.mjs';
import { seed } from '../server/seed.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const EMPTY = 'Write the folder’s full path.';
const NOT_TEXT = 'An agent’s folder is its full path, as text. Write the folder’s full path.';
const CONTROL = 'A folder’s path can’t contain control characters, such as a new line. Write the folder’s full path.';
const RELATIVE = 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.';
const HIDDEN =
  'A folder’s path can’t contain invisible characters, such as a zero-width space or a bidi control, or a lone surrogate. Write the folder’s full path.';
const PARTS = 'A folder’s path can’t have an empty, . or .. part, such as //, /./ or /../. Write the folder’s full path without them.';
const TOO_LONG = 'A folder’s path is at most 4096 characters. Pick a folder with a shorter path.';

/** Each refused folder, by the message it’s refused with. */
const FAILURES = [
  [EMPTY, ['  ', '\t', ' \n ']],
  [RELATIVE, ['.', '..', 'server', './server', '../x', 'relative/x', '~', '~/x', '~root/x', ' /tmp', 'a"<&b']],
  [CONTROL, ['/tmp/a\u0000b', '\u0000', '/tmp/a\nb', '/tmp/\u007f', '/tmp/a\u0085b']],
  [NOT_TEXT, [42, true, ['/tmp'], [], { toString: () => '/tmp' }]],
  [HIDDEN, ['/tmp/a\u202eb', '/tmp/\u2066x\u2069', '/tmp/a\u200bb', '\ufeff/tmp', '/tmp/a\ud800b', '/tmp/x\u3164']],
  [PARTS, ['/tmp/x/../../etc', '/tmp/..', '/..', '/.', '/tmp/./x', '/tmp/./', '//tmp', '/tmp//x', '/tmp//', '//']],
  [TOO_LONG, [`/${'a'.repeat(4096)}`]],
];

function setup() {
  const data = tempDir('pb-persona-folder-');
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(data, 'workspaces') }));
  const rt = new Runtime({ store, adapters, corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  return { data, store, rt };
}

/** A 422 with exactly this message, for this folder. */
const refusal = (folder, message) => (e) => {
  assert.equal(e.status, 422, JSON.stringify(folder));
  assert.equal(e.message, message, JSON.stringify(folder));
  return true;
};

test('making an agent with a relative, hidden, odd or non-text folder is refused with the project folder’s message, and makes no agent', () => {
  const { store, rt } = setup();
  for (const [message, folders] of FAILURES)
    for (const folder of folders) assert.throws(() => rt.createPersona({ handle: 'alpha', backend: 'claude-code', folder }), refusal(folder, message));
  assert.deepEqual(Object.keys(store.state.personas), []);
});

test('changing an agent’s folder to a relative, hidden, odd or non-text one is refused, and keeps the folder it had', () => {
  const { store, rt } = setup();
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', folder: '/srv/alpha' });
  for (const [message, folders] of FAILURES)
    for (const folder of folders) assert.throws(() => rt.updatePersona(p.id, { folder, description: 'changed' }), refusal(folder, message));
  assert.equal(store.state.personas[p.id].folder, '/srv/alpha');
  assert.equal(store.state.personas[p.id].description, '');
  assert.equal(store.state.personas[p.id].version, 1);
});

test('an agent’s full-path folder is kept as written, without making it, but for one / at its end', () => {
  const { data, rt } = setup();
  const gone = join(data, 'not-yet', 'a"<&b');
  const a = rt.createPersona({ handle: 'alpha', backend: 'claude-code', folder: `${gone}/` });
  assert.equal(a.folder, gone);
  assert.equal(existsSync(gone), false, 'the folder is made at the agent’s first turn, not when it’s saved');
  assert.equal(rt.updatePersona(a.id, { folder: '/srv/x/' }).folder, '/srv/x');
  assert.equal(rt.updatePersona(a.id, { folder: '/' }).folder, '/');
  assert.equal(rt.updatePersona(a.id, { folder: '/srv/mi\u200cx' }).folder, '/srv/mi\u200cx', 'ZWNJ joins letters, as a project’s folder takes it');
});

test('an empty, missing or null folder still means the project’s folder, on making an agent and on changing one', () => {
  const { rt } = setup();
  for (const [handle, folder] of [
    ['alpha', ''],
    ['beta', undefined],
    ['gamma', null],
  ])
    assert.equal(rt.createPersona({ handle, backend: 'claude-code', folder }).folder, '', String(folder));
  const p = rt.createPersona({ handle: 'delta', backend: 'claude-code', folder: '/srv/d' });
  assert.equal(rt.updatePersona(p.id, { description: 'its folder isn’t in the change' }).folder, '/srv/d');
  assert.equal(rt.updatePersona(p.id, { folder: '' }).folder, '');
  assert.equal(rt.updatePersona(p.id, { folder: '/srv/d' }).folder, '/srv/d');
  assert.equal(rt.updatePersona(p.id, { folder: null }).folder, '');
  assert.equal(rt.updatePersona(p.id, { description: 'no folder in the change' }).folder, '');
});

test('an agents.json agent with a relative folder is refused, and seeds no agent', async () => {
  const { data, store, rt } = setup();
  await writeFile(join(data, 'agents.json'), JSON.stringify([{ handle: 'alpha', folder: '~/work' }]));
  await assert.rejects(() => seed(rt, { dataDir: data, booksDir: join(data, 'books'), backend: 'claude-code' }), refusal('~/work', RELATIVE));
  assert.deepEqual(Object.keys(store.state.personas), []);
});

test('an agent stored with a relative folder before #990 is refused at its turn, naming the folder and where to change it, and the folder isn’t made', async (t) => {
  // Started in a folder of its own, inside a temp folder, so a folder made by mistake, ../x included, is made there.
  const root = tempDir('pb-persona-folder-cwd-');
  const here = join(root, 'started-here');
  mkdirSync(here);
  const was = process.cwd();
  process.chdir(here);
  t.after(() => process.chdir(was));
  const workRoot = join(here, 'workspaces');
  for (const folder of ['server', '../x', '~/x', 'a/./b']) {
    await assert.rejects(
      () => agentFolder({ handle: 'alpha', folder }, { folder: '/srv/project' }, workRoot),
      (e) => {
        assert.equal(
          e.message,
          `Postbox couldn’t open the folder ${JSON.stringify(folder)} for @alpha: ${RELATIVE} Change it in @alpha’s sheet, under Folder, or leave it empty to work in the project’s root folder.`,
        );
        return true;
      },
    );
    assert.equal(existsSync(join(here, folder)), false, `${folder} made under the folder Postbox was started from`);
  }
  assert.equal(existsSync(workRoot), false);
  assert.deepEqual(readdirSync(root), ['started-here']);
  assert.deepEqual(readdirSync(here), []);
});

test('a stored folder’s refusal shows its hidden and control characters as escapes, and a long one cut short', async () => {
  const root = tempDir('pb-persona-folder-');
  const workRoot = join(root, 'workspaces');
  const at = JSON.stringify(`${root}/a`).slice(0, -1);
  const cases = [
    [`${root}/a\u202eb`, HIDDEN, `${at}\\u202eb"`],
    [`${root}/a\u0000b`, CONTROL, `${at}\\u0000b"`],
    [`${root}/a\u0085b`, CONTROL, `${at}\\u0085b"`],
    [{ toString: () => '/tmp' }, NOT_TEXT, '{}'],
    [`${root}/a\u{e0041}b`, HIDDEN, `${at}\\u{e0041}b"`],
    [`/${'a'.repeat(5000)}`, TOO_LONG, `"/${'a'.repeat(198)}…`],
    // 200 characters as shown, quotes included, is shown whole.
    ['a'.repeat(198), RELATIVE, `"${'a'.repeat(198)}"`],
  ];
  for (const [folder, why, shown] of cases)
    await assert.rejects(
      () => agentFolder({ handle: 'alpha', folder }, null, workRoot),
      (e) => {
        assert.ok(e.message.startsWith(`Postbox couldn’t open the folder ${shown} for @alpha: ${why} Change it`), e.message);
        for (const c of ['\u0000', '\u0085', '\u202e']) assert.equal(e.message.includes(c), false, `${JSON.stringify(c)} in the message`);
        return true;
      },
    );
  assert.deepEqual(readdirSync(root), []);
});

test('an agent stored with a full-path folder, or none, still works where it did', async () => {
  const root = tempDir('pb-persona-folder-');
  const own = join(root, 'own');
  assert.equal(await agentFolder({ handle: 'alpha', folder: own }, { folder: root }, join(root, 'w')), own);
  assert.equal(existsSync(own), true);
  assert.equal(await agentFolder({ handle: 'alpha', folder: '' }, { folder: root }, join(root, 'w')), root);
  assert.equal(await agentFolder({ handle: 'alpha', folder: '' }, null, join(root, 'w')), join(root, 'w', 'alpha'));
  assert.equal(await agentFolder({ handle: 'beta' }, null, join(root, 'w')), join(root, 'w', 'beta'));
  assert.equal(await agentFolder({ handle: 'gamma', folder: null }, { folder: root }, join(root, 'w')), root);
});

test('an adapter’s folder for an agent refuses a stored relative folder', async () => {
  const workRoot = join(tempDir('pb-persona-folder-'), 'workspaces');
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot });
  await assert.rejects(() => adapter.folderFor({ handle: 'alpha', folder: 'server' }, null), /Postbox couldn’t open the folder "server" for @alpha/);
  assert.equal(existsSync(workRoot), false);
});
