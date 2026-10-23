// Host code ships to a remote host without the server (#120), so it can import only node: modules and shared/.
// install.mjs’s hostFiles is what ships, and this checks it: it follows every static import and export … from,
// transitively, starting from the tool list the host’s shim serves (shared/mcp-tools.mjs), the protocol
// (shared/remote-protocol.mjs) and every regular file under server/remote/host/, whatever its name: the `host` launcher
// has no extension, so every file is read and scanned, even one that turns out to import nothing.
// shared/catalog.mjs imports ./urls.mjs, so checking only the first level would miss a file. It fails on a file outside
// shared/ or server/remote/host/, on a bare package import, on anything under the folder that isn’t a regular file or a
// folder (a symlink could lead anywhere), and on finding nothing to check, so it can’t pass while checking nothing.

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
