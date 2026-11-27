// #314: Postbox writes an Antigravity turn’s plugin (.agents/plugins/postbox/) into the agent’s folder and removes it
// when the turn ends, in a finally. A Postbox killed mid-turn never ran it, and nothing removed the plugin later, so the
// person’s own agy sessions in that folder loaded Postbox’s rules and an MCP URL for a Postbox no longer running. Postbox
// now records where a turn wrote its plugin, beside its work root, and removes each one left there as it starts.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agyPlugin, PLUGIN_DIR, removeAgyPlugin, writeAgyPlugin } from '../server/adapters/agy-plugin.mjs';
import { sweepAgyPlugins } from '../server/adapters/agy-plugin-record.mjs';
import { tempDir } from './temp-dirs.mjs';

const files = () => agyPlugin({ mcpUrl: 'http://127.0.0.1:1/mcp/x', rules: 'Postbox’s guide' });

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
  assert.deepEqual(JSON.parse(readFileSync(join(workRoot, '..', 'agy-plugins.json'), 'utf8')), [], 'its record is dropped');
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
  writeFileSync(join(workRoot, '..', 'agy-plugins.json'), `${JSON.stringify([kept, elsewhere])}\n`);
  await sweepAgyPlugins(workRoot);
  assert.equal(readFileSync(join(kept, 'todo.md'), 'utf8'), 'mine\n', 'only a plugin’s own folder is ever removed');
});

test('#314 a plugin the turn couldn’t remove stays noted, for the next start to remove', async () => {
  const workRoot = join(tempDir('pb-agy-data-'), 'workspaces');
  const folder = tempDir('pb-agy-folder-');
  const plugin = join(folder, PLUGIN_DIR);
  await writeAgyPlugin(plugin, files(), workRoot);
  // Its folder made read-only, as an agent could: the turn’s removal fails.
  chmodSync(join(folder, '.agents', 'plugins'), 0o555);
  await removeAgyPlugin(plugin, workRoot);
  chmodSync(join(folder, '.agents', 'plugins'), 0o755);
  assert.ok(existsSync(plugin), 'still there');
  await sweepAgyPlugins(workRoot);
  assert.equal(existsSync(plugin), false, 'removed at the next start');
});
