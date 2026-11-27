// #314: Postbox writes an Antigravity turn’s plugin (.agents/plugins/postbox/) into the agent’s folder and removes it
// when the turn ends, in a finally. A Postbox killed mid-turn never ran it, and nothing removed the plugin later, so the
// person’s own agy sessions in that folder loaded Postbox’s rules and an MCP URL for a Postbox no longer running. Postbox
// now records where a turn wrote its plugin, beside its work root, and removes each one left there as it starts.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { agyPlugin, PLUGIN_DIR, removeAgyPlugin, writeAgyPlugin } from '../server/adapters/agy-plugin.mjs';
import { configHash, notePlugin, sweepAgyPlugins } from '../server/adapters/agy-plugin-record.mjs';
import { tempDir } from './temp-dirs.mjs';

const files = () => agyPlugin({ mcpUrl: 'http://127.0.0.1:1/mcp/x', rules: 'Postbox’s guide' });
/** The folders the record notes. @param {string} workRoot */
const noted = (workRoot) => JSON.parse(readFileSync(join(workRoot, '..', 'agy-plugins.json'), 'utf8')).map((/** @type {any} */ n) => n.dir);

test('#314 a plugin a crashed turn left is removed as Postbox starts, and the folder keeps its own files', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const plugin = join(folder, PLUGIN_DIR);
  // The turn wrote its plugin, then Postbox was killed: its finally, which removes the plugin, never ran.
  await writeAgyPlugin(plugin, files(), workRoot);
  assert.ok(existsSync(join(plugin, 'mcp_config.json')), 'the plugin is there');
  // The next Postbox starts.
  await sweepAgyPlugins(workRoot);
  assert.equal(existsSync(join(folder, '.agents')), false, 'the plugin, and the folders that held only it, are gone');
  await sweepAgyPlugins(workRoot);
});

test('#314 a turn that ends as it should leaves nothing to sweep, and another plugin of the folder’s own stays', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const plugin = join(folder, PLUGIN_DIR);
  await writeAgyPlugin(plugin, files(), workRoot);
  await removeAgyPlugin(plugin, workRoot);
  assert.deepEqual(noted(workRoot), [], 'its record is dropped');
  // The person’s own plugin, written after: Postbox’s record no longer names this folder, so the sweep leaves it.
  await writeAgyPlugin(join(folder, '.agents', 'plugins', 'mine'), { 'plugin.json': '{"name":"mine"}\n' });
  await sweepAgyPlugins(workRoot);
  assert.deepEqual(readdirSync(join(folder, '.agents', 'plugins')), ['mine']);
});

test('#314 Postbox’s start sweeps the plugins its work root notes, before any backend runs a turn', async () => {
  const { AdapterRegistry } = await import('../server/adapters/adapter.mjs');
  const { registerBackends } = await import('../server/backends.mjs');
  const dataDir = tempDir('pb-agy-data-');
  const folder = tempDir('pb-agy-folder-');
  const plugin = join(folder, PLUGIN_DIR);
  await writeAgyPlugin(plugin, files(), join(dataDir, 'workspaces'));
  // A start with no CLI found: what’s swept doesn’t depend on agy being installed now.
  const none = async () => null;
  await registerBackends(new AdapterRegistry(), { dataDir, demo: false, probes: { claude: none, sdk: none, kiro: none, agy: none, codex: none } });
  assert.equal(existsSync(join(folder, '.agents')), false, 'gone once Postbox has started');
});

test('#314 a record edited to name another folder removes nothing there', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const elsewhere = tempDir('pb-agy-elsewhere-');
  const kept = join(elsewhere, 'notes');
  mkdirSync(kept);
  writeFileSync(join(kept, 'todo.md'), 'mine\n');
  // With the hash of the mcp_config.json it holds, so only the path’s own check stands in the way.
  writeFileSync(join(kept, 'mcp_config.json'), '{}\n');
  writeFileSync(join(workRoot, '..', 'agy-plugins.json'), `${JSON.stringify([{ dir: kept, sha256: configHash('{}\n') }])}\n`);
  await sweepAgyPlugins(workRoot);
  assert.equal(readFileSync(join(kept, 'todo.md'), 'utf8'), 'mine\n', 'only a plugin’s own folder is ever removed');
});

// File modes don’t stop root, whose rm goes through: where the tests run as root, this case can’t make a failed removal.
const ROOT = process.getuid?.() === 0;
test('#314 a plugin the turn couldn’t remove stays noted, for the next start to remove', {
  skip: (process.platform === 'win32' || ROOT) && 'POSIX modes, not root',
}, async () => {
  // Its folder made read-only, or closed to look into, as an agent could: the turn’s removal fails.
  for (const mode of [0o555, 0o000]) {
    const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
    const folder = tempDir('pb-agy-folder-');
    const plugin = join(folder, PLUGIN_DIR);
    await writeAgyPlugin(plugin, files(), workRoot);
    chmodSync(join(folder, '.agents', 'plugins'), mode);
    await removeAgyPlugin(plugin, workRoot);
    chmodSync(join(folder, '.agents', 'plugins'), 0o755);
    assert.ok(existsSync(plugin), `still there (${mode.toString(8)})`);
    await sweepAgyPlugins(workRoot);
    assert.equal(existsSync(plugin), false, `removed at the next start (${mode.toString(8)})`);
  }
});

test('#314 a link where the plugin’s folders go isn’t followed: what it leads to stays', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const elsewhere = tempDir('pb-agy-elsewhere-');
  // A repository that commits .agents/plugins as a link, or a person who links it to a folder shared across projects.
  mkdirSync(join(folder, '.agents'));
  symlinkSync(elsewhere, join(folder, '.agents', 'plugins'));
  await writeAgyPlugin(join(folder, PLUGIN_DIR), files(), workRoot);
  writeFileSync(join(elsewhere, 'postbox', 'mine.txt'), 'mine\n');
  await sweepAgyPlugins(workRoot);
  assert.equal(readFileSync(join(elsewhere, 'postbox', 'mine.txt'), 'utf8'), 'mine\n');
});

test('#314 a folder at the noted path that isn’t the plugin the turn wrote is left as it is', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const plugin = join(folder, PLUGIN_DIR);
  await writeAgyPlugin(plugin, files(), workRoot);
  // After the crash, another Postbox’s turn, or the person, put a plugin there with another MCP URL.
  writeFileSync(join(plugin, 'mcp_config.json'), '{"mcpServers":{"postbox":{"serverUrl":"http://127.0.0.1:2/mcp?turn=other"}}}\n');
  await sweepAgyPlugins(workRoot);
  assert.ok(existsSync(join(plugin, 'mcp_config.json')), 'not the plugin noted: it stays');
  assert.deepEqual(noted(workRoot), [], 'and its note is dropped');
});

test('#314 turns in many folders at once each get noted', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const dirs = Array.from({ length: 8 }, () => join(tempDir('pb-agy-folder-'), PLUGIN_DIR));
  await Promise.all(dirs.map((d) => notePlugin(workRoot, d, 'sha')));
  assert.equal(noted(workRoot).length, 8);
});

test('#314 a plugin the sweep can’t remove stays noted, and one it removed doesn’t', {
  skip: (process.platform === 'win32' || ROOT) && 'POSIX modes, not root',
}, async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const plugin = join(folder, PLUGIN_DIR);
  await writeAgyPlugin(plugin, files(), workRoot);
  chmodSync(join(folder, '.agents', 'plugins'), 0o555);
  const said = mock.method(console, 'error', () => {});
  try {
    await sweepAgyPlugins(workRoot);
  } finally {
    said.mock.restore();
    chmodSync(join(folder, '.agents', 'plugins'), 0o755);
  }
  assert.ok(existsSync(plugin), 'still there');
  assert.deepEqual(noted(workRoot), [plugin], 'and still noted');
  await sweepAgyPlugins(workRoot);
  assert.deepEqual(noted(workRoot), [], 'gone, and no longer noted');
});

test('#314 a turn removes the plugin it wrote through a linked plugins folder', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const shared = tempDir('pb-agy-shared-');
  mkdirSync(join(folder, '.agents'));
  symlinkSync(shared, join(folder, '.agents', 'plugins'));
  const plugin = join(folder, PLUGIN_DIR);
  await writeAgyPlugin(plugin, files(), workRoot);
  await removeAgyPlugin(plugin, workRoot);
  assert.equal(existsSync(join(shared, 'postbox')), false, 'removed where its write went');
  assert.deepEqual(noted(workRoot), [], 'and unnoted');
});
