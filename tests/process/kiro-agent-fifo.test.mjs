// #1864: a FIFO at a noted Kiro agent file’s path must not hang Postbox’s start. The sweep hashes a noted file only when
// it’s a regular file (server/adapters/kiro-agent-files.mjs): a read of a FIFO waits for a writer for ever. Here because
// making a FIFO starts mkfifo, which unit tests may not.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepKiroAgents } from '../../server/adapters/kiro-agent-files.mjs';
import { tempDir } from '../temp-dirs.mjs';

test('#1864 a FIFO at the noted path is left, without the start reading it', {
  skip: process.platform === 'win32' && 'POSIX FIFOs',
  timeout: 10_000,
}, async () => {
  const data = tempDir('pb-kiro-fifo-');
  mkdirSync(join(data, 'home', 'agents'), { recursive: true });
  const fifo = join(data, 'home', 'agents', 'postbox-kiro-0f0f0f0f.json');
  execFileSync('mkfifo', [fifo]);
  writeFileSync(join(data, 'kiro-agents.json'), `${JSON.stringify([{ file: fifo, sha256: 'x' }])}\n`);
  await sweepKiroAgents(join(data, 'work'));
  assert.ok(existsSync(fifo), 'left');
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'kiro-agents.json'), 'utf8')), [], 'and dropped from the record');
});
