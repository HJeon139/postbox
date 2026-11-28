// Host code ships to a remote host without the server (#120), so it can import only node: modules and shared/.
// install.mjs’s hostFiles is what ships, and this checks it: it follows every static import and export … from,
// transitively, starting from the tool list the host’s shim serves (shared/mcp-tools.mjs), the protocol
// (shared/remote-protocol.mjs) and every regular file under server/remote/host/, whatever its name: the `host` launcher
// has no extension, so every file is read and scanned, even one that turns out to import nothing.
// shared/catalog.mjs imports ./urls.mjs, so checking only the first level would miss a file. It fails on a file outside
// shared/ or server/remote/host/, on a bare package import, on anything under the folder that isn’t a regular file or a
// folder (a symlink could lead anywhere), and on finding nothing to check, so it can’t pass while checking nothing.
// Postbox’s agent plugin (agent-plugin/) ships too, as data, so a turn on a host loads its skills (#207): its Markdown and
// JSON files, .claude-plugin/plugin.json the only dotted path allowed.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostFiles } from '../server/remote/install.mjs';

test('host code imports only node: modules and shared/, transitively', (t) => {
  const { files, problems } = hostFiles();
  t.diagnostic(`checked ${files.length} files: ${files.join(', ')}`);
  assert.ok(files.length > 0, 'found no host files to check');
  for (const f of ['server/remote/host/host', 'server/remote/host/host.mjs', 'shared/limits.mjs']) assert.ok(files.includes(f), `${f} ships`);
  assert.deepEqual(problems, []);
});

test('the host-code check fails on a package import, a file outside shared/ and a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-imports-'));
  try {
    mkdirSync(join(root, 'server', 'remote', 'host'), { recursive: true });
    mkdirSync(join(root, 'shared'));
    mkdirSync(join(root, 'server', 'other'));
    writeFileSync(join(root, 'shared', 'mcp-tools.mjs'), "import './limits.mjs';\n");
    writeFileSync(join(root, 'shared', 'limits.mjs'), 'export const x = 1;\n');
    writeFileSync(join(root, 'shared', 'remote-protocol.mjs'), "import pkg from 'some-package';\n");
    writeFileSync(join(root, 'server', 'remote', 'host', 'a.mjs'), "import '../../other/b.mjs';\n");
    writeFileSync(join(root, 'server', 'other', 'b.mjs'), '');
    symlinkSync('/etc/hosts', join(root, 'server', 'remote', 'host', 'link'));
    const { files, problems } = hostFiles(root);
    assert.deepEqual(files, ['server/remote/host/a.mjs', 'shared/limits.mjs', 'shared/mcp-tools.mjs', 'shared/remote-protocol.mjs']);
    assert.deepEqual(problems.sort(), [
      'server/other/b.mjs is outside shared/ and server/remote/host/',
      'server/remote/host/link isn’t a regular file or a folder',
      'shared/remote-protocol.mjs imports the package “some-package”',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#207: the agent plugin ships, its .claude-plugin/plugin.json too, unscanned', () => {
  const { files, problems } = hostFiles();
  for (const f of [
    'agent-plugin/.claude-plugin/plugin.json',
    'agent-plugin/skills/visual-explainer/SKILL.md',
    'agent-plugin/skills/visual-explainer/references/brief.md',
  ])
    assert.ok(files.includes(f), `${f} ships`);
  assert.deepEqual(problems, []);
});

test('#207: the plugin ships its Markdown and JSON and the manifest, leaves other files behind, and refuses a symlink or a huge file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-plugin-'));
  try {
    mkdirSync(join(root, 'server', 'remote', 'host'), { recursive: true });
    mkdirSync(join(root, 'shared'));
    writeFileSync(join(root, 'shared', 'mcp-tools.mjs'), '');
    writeFileSync(join(root, 'shared', 'remote-protocol.mjs'), '');
    const plugin = join(root, 'agent-plugin');
    for (const dir of ['.claude-plugin', 'skills/s/.claude-plugin', 'skills/.hidden']) mkdirSync(join(plugin, dir), { recursive: true });
    // A skill file isn’t code: an import in it isn’t followed.
    writeFileSync(join(plugin, 'skills', 's', 'SKILL.md'), "import x from 'some-package';\n");
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{}');
    writeFileSync(join(plugin, '.claude-plugin', 'other.json'), '{}');
    writeFileSync(join(plugin, 'skills', 's', '.claude-plugin', 'plugin.json'), '{}');
    writeFileSync(join(plugin, 'skills', '.hidden', 'x.md'), '');
    writeFileSync(join(plugin, '.env'), '');
    writeFileSync(join(plugin, 'skills', '.DS_Store'), ''); // what Finder leaves once the folder is opened
    writeFileSync(join(plugin, 'skills', 's', 'notes.txt'), '');
    writeFileSync(join(plugin, 'skills', 's', 'huge.md'), 'x'.repeat(64 * 1024 + 1));
    symlinkSync('/etc/hosts', join(plugin, 'skills', 's', 'link.md'));
    const { files, problems } = hostFiles(root);
    const shipped = files.filter((f) => f.startsWith('agent-plugin/'));
    assert.deepEqual(shipped, ['agent-plugin/.claude-plugin/plugin.json', 'agent-plugin/skills/s/SKILL.md'], 'only the skill and the manifest');
    assert.deepEqual(problems.sort(), [
      'agent-plugin/skills/s/huge.md is past 65536 bytes, more than a skill’s file',
      'agent-plugin/skills/s/link.md isn’t a regular file or a folder',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#207: a plugin folder that’s a symlink doesn’t ship', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-plugin-link-'));
  try {
    mkdirSync(join(root, 'shared'), { recursive: true });
    mkdirSync(join(root, 'elsewhere', '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'shared', 'mcp-tools.mjs'), '');
    writeFileSync(join(root, 'shared', 'remote-protocol.mjs'), '');
    writeFileSync(join(root, 'elsewhere', 'secret.md'), '');
    symlinkSync(join(root, 'elsewhere'), join(root, 'agent-plugin'));
    const { files, problems } = hostFiles(root);
    assert.ok(!files.some((f) => f.startsWith('agent-plugin/')));
    assert.deepEqual(problems, ['agent-plugin isn’t a folder']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
