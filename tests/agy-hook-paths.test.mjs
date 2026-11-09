// #1074: the Antigravity hook judges a file call by every path it names, and by where each one leads, so what it
// allows with no card is what agy reads or writes: a second field, a ~ path, a link before a .., and a readable folder
// later replaced by a link. agy’s own skills and guide read with no card, the kind of card nobody can usefully judge
// (designs/intent.md, principle 8).

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool, isProtectedPath, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

const READS = ['read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search'];

/** A home with a project, a notes folder, a key in ~/.ssh, agy’s own folder, and a folder outside both. */
function aHome() {
  const home = realpathSync(tempDir('pb-agy-paths-'));
  const ws = join(home, 'ws');
  const out = join(home, 'outside');
  const notes = join(home, 'notes');
  const ssh = join(home, '.ssh');
  const guide = join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills', 'antigravity_guide');
  for (const d of [ws, out, notes, join(ssh, 'sub'), join(out, 'sub'), guide]) mkdirSync(d, { recursive: true });
  for (const f of [join(ws, 'a.txt'), join(notes, 'a.md'), join(ssh, 'id_rsa'), join(out, 'secret.txt'), join(guide, 'SKILL.md')]) writeFileSync(f, 'x');
  return { home, ws, out, notes, ssh, guide };
}

const decide = (name, args, opts) => decideAgyTool({ toolCall: { name, args } }, opts);

test('#1074 a read naming a project file and a second path outside the folders gets a card for the second', () => {
  const { home, ws, ssh } = aHome();
  for (const name of READS) {
    for (const field of ['SearchPath', 'SearchDirectory', 'DirectoryPath', 'AbsolutePath']) {
      const res = decide(name, { Path: join(ws, 'a.txt'), [field]: ssh }, { mode: 'ask', folders: [ws], cwd: ws, home });
      assert.deepEqual(res, { decision: 'ask', toolName: 'Read', input: { file_path: ssh } }, `${name} ${field}`);
    }
    assert.equal(decide(name, { Path: join(ws, 'a.txt'), SearchPath: ws }, { folders: [ws], cwd: ws, home }).decision, 'allow', `${name} both inside`);
  }
});

test('#1074 a read naming two paths outside the folders names both on its card', () => {
  const { home, ws, notes, ssh } = aHome();
  const res = decide('grep_search', { Path: join(notes, 'a.md'), SearchPath: ssh }, { mode: 'ask', folders: [ws], cwd: ws, home });
  assert.deepEqual(res, { decision: 'ask', toolName: 'Read', input: { file_path: join(notes, 'a.md'), paths: [join(notes, 'a.md'), ssh] } });
});

test('#1074 a write naming a project file and a second path is refused or asks by the second', () => {
  const { home, ws, out } = aHome();
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  assert.equal(decide('write_to_file', { Path: join(ws, 'a.txt'), TargetFile: settings }, opts).decision, 'deny');
  assert.deepEqual(decide('replace_file_content', { Path: join(ws, 'a.txt'), TargetFile: join(out, 'x.txt') }, opts), {
    decision: 'ask',
    toolName: 'Edit',
    input: { file_path: join(out, 'x.txt') },
  });
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'a.txt'), Path: join(ws, 'b.txt') }, opts).decision, 'allow');
});

test('#1074 a ~ path is judged as the home folder too, since whether agy expands ~ is unproved', () => {
  const { home, ws } = aHome();
  const opts = { mode: 'acceptEdits', folders: [ws], cwd: ws, home };
  assert.deepEqual(decide('read_file', { Path: '~/.ssh/id_rsa' }, opts), { decision: 'ask', toolName: 'Read', input: { file_path: '~/.ssh/id_rsa' } });
  assert.equal(decide('write_file', { Path: '~/.gemini/antigravity-cli/settings.json' }, opts).decision, 'deny');
  assert.equal(isProtectedPath('~/.gemini/antigravity-cli/settings.json', { cwd: ws, home }), true);
  assert.equal(decide('edit_file', { Path: '~/outside/x.txt' }, opts).decision, 'ask', 'in the project as cwd/~, outside it as home');
  assert.equal(decide('read_file', { Path: '~notes/a.md' }, opts).decision, 'allow', 'a name that only starts with ~ is a file in the project');
});

test('#1074 a ~ path that leads into the folders read either way needs no card', () => {
  const { home, ws } = aHome();
  assert.equal(decide('read_file', { Path: '~/ws/a.txt' }, { mode: 'ask', folders: [ws], cwd: ws, home }).decision, 'allow');
});

test('#1074 agy’s own builtin skills and guide read with no card, and are still never edited', () => {
  const { home, ws, guide } = aHome();
  for (const mode of ['ask', 'auto', 'acceptEdits']) {
    const opts = { mode, folders: [ws], cwd: ws, home };
    assert.equal(decide('view_file', { AbsolutePath: join(guide, 'SKILL.md') }, opts).decision, 'allow', mode);
    assert.equal(
      decide('read_file', { Path: join(home, '.gemini', 'antigravity-cli', 'settings.json') }, opts).decision,
      'ask',
      `${mode}: settings still asks`,
    );
    assert.equal(decide('write_to_file', { TargetFile: join(guide, 'SKILL.md') }, opts).decision, 'deny', mode);
  }
});

test('#1074 a readable folder later replaced by a link to ~/.ssh allows nothing through the link', () => {
  const { home, ws, ssh } = aHome();
  const saved = join(home, 'shared');
  symlinkSync(ssh, saved);
  const res = decide('read_file', { Path: join(saved, 'id_rsa') }, { mode: 'ask', folders: [ws], readFolders: [saved], cwd: ws, home });
  assert.equal(res.decision, 'ask');
});

test('#1074 a .. after a link climbs from where the link leads, as the file system does', () => {
  const { home, ws, out, notes, ssh } = aHome();
  symlinkSync(join(ssh, 'sub'), join(notes, 'sublink'));
  symlinkSync(join(out, 'sub'), join(ws, 'sublink'));
  const opts = { mode: 'auto', folders: [ws], readFolders: [notes], cwd: ws, home };
  assert.equal(decide('read_file', { Path: `${notes}/sublink/../id_rsa` }, opts).decision, 'ask', 'notes/sublink/.. is ~/.ssh');
  assert.equal(decide('read_file', { Path: 'sublink/../secret.txt' }, opts).decision, 'ask', 'ws/sublink/.. is outside');
  assert.equal(decide('write_file', { Path: `${ws}/sublink/../secret.txt` }, opts).decision, 'ask');
  assert.equal(decide('read_file', { Path: `${notes}/../notes/a.md` }, opts).decision, 'allow', 'a .. with no link is the folder’s own');
});

test('#1074 in Auto, a command’s .. after a link climbs from where the link leads, so it isn’t routine', () => {
  const { home, ws, ssh } = aHome();
  symlinkSync(join(ssh, 'sub'), join(ws, 'sublink'));
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  assert.equal(decide('run_command', { CommandLine: 'cat sublink/../id_rsa' }, opts).decision, 'ask', 'ws/sublink/.. is ~/.ssh');
  assert.equal(decide('run_command', { CommandLine: 'cp a.txt sublink/../x' }, opts).decision, 'ask', 'a write there too');
  assert.equal(decide('run_command', { CommandLine: 'cat ../ws/a.txt' }, opts).decision, 'allow', 'a .. with no link is the folder’s own');
});

test('#1074 an edited path on a card goes back in the field the card was about', async () => {
  const { home, ws, out } = aHome();
  const args = { Path: join(ws, 'a.txt'), SearchPath: join(out, 'secret.txt') };
  /** @type {any} */
  let asked = null;
  const fetchImpl = async (_url, { body }) => {
    const rpc = JSON.parse(body);
    asked = rpc.params.arguments.input;
    const text = JSON.stringify({ behavior: 'allow', updatedInput: { file_path: join(out, 'other.txt') } });
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }] } }) };
  };
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'ask', POSTBOX_AGY_FOLDERS: JSON.stringify([ws]) };
  const res = await runAgyHook(JSON.stringify({ toolCall: { name: 'grep_search', args } }), { cwd: ws, env, home, fetchImpl: /** @type {any} */ (fetchImpl) });
  assert.deepEqual(asked, { file_path: join(out, 'secret.txt') });
  assert.deepEqual(res, { decision: 'allow', overwrite: { ...args, SearchPath: join(out, 'other.txt') } });
});

test('#1074 in Auto, a ~ edit that leads into .git through a link in home asks', () => {
  const { home, ws } = aHome();
  mkdirSync(join(ws, '.git'));
  symlinkSync(join(ws, '.git'), join(home, 'gitlink'));
  assert.equal(decide('write_file', { Path: '~/gitlink/config' }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask');
});

test('#1074 a read naming a path that isn’t a string next to a project file asks, with nothing to show', () => {
  const { home, ws } = aHome();
  const res = decide('grep_search', { Path: join(ws, 'a.txt'), SearchPath: 42 }, { mode: 'auto', folders: [ws], cwd: ws, home });
  assert.deepEqual(res, { decision: 'ask', toolName: 'Read', input: { file_path: '' } });
});
