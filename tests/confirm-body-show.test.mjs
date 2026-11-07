// #852: show_block and update_block read the file a confirm’s `gh … --body-file` posts, from the agent’s places, and
// keep it on the item, so the person reads what it posts before they confirm. One Postbox can’t read there refuses
// the whole block, with the reason, as any other invalid block is refused.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setup } from './review-files-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const confirm = (id, commands) => ({
  block: { id, type: 'confirm', version: 1, fallback: 'Open the PR?', statement: 'Open the pull request?', confirmLabel: 'Open it', commands },
});
const confirmItem = (f, id) => f.store.items(f.t.id).find((i) => i.kind === 'block' && i.block?.id === id);
// This file: in the clone, so in none of the agent’s places and not in the system temp folder, where the fixture’s
// folders are.
const OUTSIDE = fileURLToPath(import.meta.url);
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

test('show_block keeps the body file a confirm’s command posts, with its SHA-256 and text', async () => {
  const f = await setup();
  const path = join(f.folder, 'body.md');
  writeFileSync(path, 'Fixes #852\n');
  const r = await f.call('show_block', confirm('pr', ['git status', `gh pr create --title T --body-file ${path}`]));
  assert.equal(r.isError, false, r.text);
  const it = confirmItem(f, 'pr');
  assert.equal(it.valid, true);
  assert.deepEqual(it.bodyFiles, [
    { command: 1, path, real: path, sha256: '25cb0f2db5f922cdbe12ff4b39d9f8694405d60c47f6956478f1a50330b66b0f', size: 11, text: 'Fixes #852\n', lines: 1 },
  ]);
});

test('show_block keeps only the first 40 lines of a longer body file, and how many it has', async () => {
  const f = await setup();
  const path = join(f.folder, 'long.md');
  writeFileSync(path, lines(60));
  const r = await f.call('show_block', confirm('long', [`gh issue create --title T --body-file ${path}`]));
  assert.equal(r.isError, false, r.text);
  const [kept] = confirmItem(f, 'long').bodyFiles;
  assert.equal(kept.text, lines(40));
  assert.equal(kept.lines, 60);
  assert.equal(kept.size, Buffer.byteLength(lines(60)));
});

test('show_block refuses a confirm whose body file is outside the agent’s places, and shows nothing', async () => {
  const f = await setup();
  const path = OUTSIDE;
  const r = await f.call('show_block', confirm('pr', [`gh pr create --title T --body-file ${path}`]));
  assert.equal(r.isError, true);
  assert.ok(r.text.includes(path), r.text);
  assert.equal(confirmItem(f, 'pr'), undefined, 'no item was added');
});

test('show_block takes a body file in a temp folder of this user’s', async () => {
  const f = await setup();
  const dir = tempDir('pb-confirm-body-tmp-');
  const path = join(dir, 'body.md');
  writeFileSync(path, 'from tmp');
  const r = await f.call('show_block', confirm('tmp', [`gh pr comment 5 --body-file ${path}`]));
  assert.equal(r.isError, false, r.text);
  assert.equal(confirmItem(f, 'tmp').bodyFiles[0].text, 'from tmp');
});

test('show_block refuses a confirm whose --body-file names no file', async () => {
  const f = await setup();
  const r = await f.call('show_block', confirm('pr', ['gh pr create --title T --body-file']));
  assert.equal(r.isError, true);
  assert.match(r.text, /--body-file/);
  assert.equal(confirmItem(f, 'pr'), undefined);
});

test('show_block called without reading the body files refuses the confirm', () => {
  // A path that skips the MCP step (a remote turn, a direct call) can’t show what the file posts, so it fails closed.
  return setup().then((f) => {
    const r = f.rt.toolsFor(f.se.id).show_block(confirm('pr', [`gh pr create --title T --body-file ${join(f.folder, 'b.md')}`]));
    assert.equal(r.ok, false);
    assert.match(r.message, /body-file/);
    assert.equal(confirmItem(f, 'pr'), undefined);
  });
});

test('update_block reads the body file again and keeps the new one', async () => {
  const f = await setup();
  const path = join(f.folder, 'body.md');
  writeFileSync(path, 'first');
  assert.equal((await f.call('show_block', confirm('pr', [`gh pr create --title T --body-file ${path}`]))).isError, false);
  writeFileSync(path, 'second');
  const r = await f.call('update_block', confirm('pr', [`gh pr create --title T2 --body-file ${path}`]));
  assert.equal(r.isError, false, r.text);
  assert.equal(confirmItem(f, 'pr').bodyFiles[0].text, 'second');
});

test('update_block refuses a body file outside the agent’s places, and keeps the one shown', async () => {
  const f = await setup();
  const path = join(f.folder, 'body.md');
  writeFileSync(path, 'first');
  assert.equal((await f.call('show_block', confirm('pr', [`gh pr create --title T --body-file ${path}`]))).isError, false);
  const r = await f.call('update_block', confirm('pr', [`gh pr create --title T --body-file ${OUTSIDE}`]));
  assert.equal(r.isError, true);
  assert.ok(r.text.includes(OUTSIDE), r.text);
  assert.equal(confirmItem(f, 'pr').bodyFiles[0].text, 'first');
});
