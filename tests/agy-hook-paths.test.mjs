// #1074: the Antigravity hook judges a file call by every path it names, and by where each one leads, so what it
// allows with no card is what agy reads or writes: a second field, a ~ path, a link before a .., and a readable folder
// later replaced by a link. agy’s own skills and guide read with no card, the kind of card nobody can usefully judge
// (designs/intent.md, principle 8).

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool, isProtectedPath, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { describePermission } from '../server/adapters/claude-permission.mjs';
import { inReadFolder } from '../server/read-folders.mjs';
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
});

test('#1074 a bare ~ is the home folder too, so listing it asks', () => {
  const { home, ws } = aHome();
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  assert.deepEqual(decide('list_dir', { DirectoryPath: '~' }, opts), { decision: 'ask', toolName: 'Read', input: { file_path: '~' } });
  assert.equal(decide('run_command', { CommandLine: 'ls ~' }, opts).decision, 'ask', 'a routine command’s ~ too');
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
  const res = decide('read_file', { Path: join(saved, 'id_rsa') }, { mode: 'ask', folders: [ws], cwd: ws, home });
  assert.equal(res.decision, 'ask');
  // Postbox answers it, comparing where the read leads with the folder as saved, not resolved again.
  const sessions = { s1: { personaId: 'p1', readDirs: [saved] } };
  const rt = { s: { sessions }, store: { pending: { session: (id) => sessions[id] } }, persona: () => ({ backend: 'antigravity-cli' }) };
  assert.equal(inReadFolder(rt, 's1', { tool: res.toolName, input: res.input }), false, 'a card, not a read through the link');
});

test('#1074 a .. after a link climbs from where the link leads, as the file system does', () => {
  const { home, ws, out, notes, ssh } = aHome();
  symlinkSync(join(ssh, 'sub'), join(notes, 'sublink'));
  symlinkSync(join(out, 'sub'), join(ws, 'sublink'));
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  assert.equal(decide('read_file', { Path: `${notes}/sublink/../id_rsa` }, opts).decision, 'ask', 'notes/sublink/.. is ~/.ssh');
  assert.equal(decide('read_file', { Path: 'sublink/../secret.txt' }, opts).decision, 'ask', 'ws/sublink/.. is outside');
  assert.equal(decide('write_file', { Path: `${ws}/sublink/../secret.txt` }, opts).decision, 'ask');
  assert.equal(decide('read_file', { Path: `${ws}/../ws/a.txt` }, opts).decision, 'allow', 'a .. with no link is the folder’s own');
  assert.equal(decide('read_file', { Path: `${notes}/../notes/a.md` }, opts).decision, 'ask', 'a readable folder is Postbox’s to answer');
});

test('#1074 a .. after a link inside the workspace asks when its plain reading leaves it, read or write, in every mode', () => {
  const { home, ws } = aHome();
  mkdirSync(join(ws, 'x', 'y', 'z'), { recursive: true });
  symlinkSync(join(ws, 'x', 'y', 'z'), join(ws, 'a'));
  // The file system reads ws/x/outside.txt, inside; read as text, a/../../ leaves ws. Which agy does is unproved.
  for (const mode of ['ask', 'acceptEdits', 'auto']) {
    const opts = { mode, folders: [ws], cwd: ws, home };
    assert.equal(decide('view_file', { AbsolutePath: `${ws}/a/../../outside.txt` }, opts).decision, 'ask', `${mode}: a read`);
    assert.equal(decide('write_to_file', { TargetFile: `${ws}/a/../../outside.txt` }, opts).decision, 'ask', `${mode}: a write`);
    assert.equal(decide('read_file', { Path: 'a/../../secret/key' }, opts).decision, 'ask', `${mode}: a relative read`);
  }
  // Both readings inside: still allowed.
  assert.equal(decide('view_file', { AbsolutePath: `${ws}/a/../inside.txt` }, { mode: 'ask', folders: [ws], cwd: ws, home }).decision, 'allow');
});

test('#1074 in Auto, an edit whose plain reading is in .git asks, though a link hides it from the file system’s', () => {
  const { home, ws } = aHome();
  mkdirSync(join(ws, 'x', 'y', 'z'), { recursive: true });
  mkdirSync(join(ws, '.git'));
  symlinkSync(join(ws, 'x', 'y', 'z'), join(ws, 'a'));
  symlinkSync(join(ws, '.git'), join(ws, 'g'));
  // Read as text, a/../g/config is g/config, which is .git/config; the file system reads x/y/g/config.
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  assert.equal(decide('write_to_file', { TargetFile: `${ws}/a/../g/config` }, opts).decision, 'ask', 'an edit');
  assert.equal(decide('run_command', { CommandLine: 'touch a/../g/config' }, opts).decision, 'ask', 'a routine write');
  assert.equal(decide('run_command', { CommandLine: 'cp a.txt a/../g/config' }, opts).decision, 'ask', 'a copy there');
});

test('#1074 a write whose plain reading is agy’s own settings is refused, though a link hides it from the file system’s', () => {
  const { home, ws } = aHome();
  const agy = join(home, '.gemini', 'antigravity-cli');
  mkdirSync(join(ws, 'x', 'y', 'z'), { recursive: true });
  symlinkSync(join(ws, 'x', 'y', 'z'), join(ws, 'a'));
  symlinkSync(agy, join(ws, 'agy'));
  for (const mode of ['ask', 'acceptEdits', 'auto'])
    assert.equal(decide('write_to_file', { TargetFile: `${ws}/a/../agy/settings.json` }, { mode, folders: [ws], cwd: ws, home }).decision, 'deny', mode);
  // The agent’s folder is home: the write would otherwise be inside it, and allowed in Accept edits and Auto.
  mkdirSync(join(home, 'x', 'y'), { recursive: true });
  symlinkSync(join(home, 'x', 'y'), join(home, 'a'));
  symlinkSync(agy, join(home, 'l'));
  for (const mode of ['acceptEdits', 'auto'])
    assert.equal(
      decide('write_to_file', { TargetFile: `${home}/a/../l/settings.json` }, { mode, folders: [home], cwd: home, home }).decision,
      'deny',
      `home, ${mode}`,
    );
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

test('#1074 a read card names every outside path on a line of its own, however long the first', () => {
  const { home, ws, out, ssh } = aHome();
  const opts = { mode: 'ask', folders: [ws], cwd: ws, home };
  const dots = decide('grep_search', { Path: `${out}/${'./'.repeat(1100)}secret.txt`, SearchPath: ssh }, opts);
  assert.deepEqual(describePermission('Read', dots.input).detail.split('\n'), [join(out, 'secret.txt'), ssh], 'its ./ runs dropped');
  const deep = decide('grep_search', { Path: `${out}/${'sub/'.repeat(1100)}secret.txt`, SearchPath: ssh }, opts);
  const { detail } = describePermission('Read', deep.input);
  const [first, second] = detail.split('\n');
  assert.ok(detail.length <= 4000, 'within what the card keeps');
  assert.equal(second, ssh);
  assert.ok(first.startsWith(`${out}/sub/`) && first.includes('…') && first.endsWith('/sub/secret.txt'), 'the long one clipped, with a mark');
});

test('#1074 a write card names its path with its ./ runs dropped', () => {
  const { home, ws, out } = aHome();
  const res = decide('write_file', { Path: `${out}/${'./'.repeat(1100)}x.txt` }, { mode: 'ask', folders: [ws], cwd: ws, home });
  assert.deepEqual(res, { decision: 'ask', toolName: 'Write', input: { file_path: join(out, 'x.txt') } });
});

test('#1074 an edited path on a card about a tidied path goes back in that path’s field', async () => {
  const { home, ws, out } = aHome();
  const args = { Path: join(ws, 'a.txt'), SearchPath: `${out}/./secret.txt` };
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

test('#1074 a ~user path may be anyone’s home, so a file call naming one asks, as Auto’s commands do', () => {
  const { home, ws } = aHome();
  mkdirSync(join(ws, '~root', '.ssh'), { recursive: true });
  for (const mode of ['ask', 'auto', 'acceptEdits']) {
    const opts = { mode, folders: [ws], cwd: ws, home };
    assert.deepEqual(decide('read_file', { Path: '~root/.ssh/x' }, opts), { decision: 'ask', toolName: 'Read', input: { file_path: '~root/.ssh/x' } }, mode);
    assert.equal(decide('read_file', { Path: '~notes/a.md' }, opts).decision, 'ask', `${mode}: a folder named ~notes in the project asks too`);
    assert.equal(decide('write_file', { Path: '~root/.ssh/authorized_keys' }, opts).decision, 'ask', `${mode}: a write`);
    assert.equal(decide('write_file', { Path: '~you/.gemini/antigravity-cli/settings.json' }, opts).decision, 'deny', `${mode}: it may be this home`);
  }
  assert.equal(decide('run_command', { CommandLine: 'cat ~root/.ssh/x' }, { mode: 'auto', folders: [ws], cwd: ws, home }).decision, 'ask', 'Auto agrees');
});

test('#1074 a ~user path asks even where, read from this home, it leads into the folders', () => {
  const { home, ws } = aHome();
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  assert.equal(decide('read_file', { Path: '~root/ws/a.txt' }, opts).decision, 'ask', 'root’s home isn’t this one');
  assert.equal(decide('write_file', { Path: '~root/ws/a.txt' }, opts).decision, 'ask');
});

test('#1074 a read card for a path that isn’t a string says so, where it would name none', () => {
  const { home, ws } = aHome();
  const res = decide('grep_search', { Path: join(ws, 'a.txt'), SearchPath: ['~/.ssh/id_rsa'] }, { mode: 'ask', folders: [ws], cwd: ws, home });
  assert.deepEqual(res, { decision: 'ask', toolName: 'Read', input: { file_path: '' } });
  assert.match(describePermission('Read', res.input).detail, /isn’t text/);
});
