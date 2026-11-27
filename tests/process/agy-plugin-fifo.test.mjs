// #314: a FIFO where a noted Antigravity plugin’s mcp_config.json goes must not hang Postbox’s start. The sweep hashes
// that file only when it’s a regular file (server/adapters/agy-plugin-record.mjs): a read of a FIFO waits for a writer for
// ever. Here because making a FIFO starts mkfifo, which unit tests may not.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN_DIR, sweepAgyPlugins } from '../../server/adapters/agy-plugin-record.mjs';
import { tempDir } from '../temp-dirs.mjs';

test('#314 a FIFO where mcp_config.json goes is left, without the start reading it', {
  skip: process.platform === 'win32' && 'POSIX FIFOs',
  timeout: 10_000,
}, async () => {
  const data = tempDir('pb-agy-fifo-');
  const dir = join(tempDir('pb-agy-folder-'), PLUGIN_DIR);
  mkdirSync(dir, { recursive: true });
  execFileSync('mkfifo', [join(dir, 'mcp_config.json')]);
  writeFileSync(join(data, 'agy-plugins.json'), `${JSON.stringify([{ dir, sha256: 'x' }])}\n`);
  await sweepAgyPlugins(join(data, 'workspaces'));
  assert.ok(existsSync(dir), 'left');
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'agy-plugins.json'), 'utf8')), [], 'and dropped from the record');
});
