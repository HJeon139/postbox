// #479: Kiro keeps memory per Kiro home, with memory.mode and memory.reflection in that home’s settings/cli.json, and
// no per-run flag or variable for them (kiro-cli 2.34.1: `kiro-cli settings --help`, `settings list --all`). An
// Isolated persona runs with the Kiro home Postbox owns, which every Isolated persona shares, so Postbox turns memory
// off there before each turn. The file’s shape is the one kiro-cli 2.34.1 wrote for `KIRO_HOME=<temp> kiro-cli settings
// memory.mode disabled`: one flat key per setting. Postbox leaves the person’s own Kiro settings alone.

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { kiroMemoryOff } from '../server/remote/host/kiro-memory.mjs';
import { fakeCtx, fakeSpawn, fixture } from './kiro-cli-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

const settings = (/** @type {string} */ home) => JSON.parse(readFileSync(join(home, 'settings', 'cli.json'), 'utf8'));

test('#479: memory goes off in a Kiro home, and the home’s other settings stay', async () => {
  const home = tempDir('postbox-kiro-memory-');
  await kiroMemoryOff(home);
  assert.deepEqual(settings(home), { 'memory.mode': 'disabled', 'memory.reflection': false });
  writeFileSync(join(home, 'settings', 'cli.json'), JSON.stringify({ 'chat.defaultModel': 'x', 'memory.mode': 'read_write' }));
  await kiroMemoryOff(home);
  assert.deepEqual(settings(home), { 'chat.defaultModel': 'x', 'memory.mode': 'disabled', 'memory.reflection': false });
  assert.equal(statSync(join(home, 'settings', 'cli.json')).mode & 0o777, 0o600, 'only its owner reads it, as Kiro writes it');
  // A file Kiro couldn’t read either is replaced.
  for (const broken of ['{not json', '[1]', 'null']) {
    writeFileSync(join(home, 'settings', 'cli.json'), broken);
    await kiroMemoryOff(home);
    assert.deepEqual(settings(home), { 'memory.mode': 'disabled', 'memory.reflection': false }, broken);
  }
});

test('#479: two turns starting together both turn memory off, and leave no temporary file', async () => {
  const home = tempDir('postbox-kiro-memory-race-');
  await Promise.all(Array.from({ length: 8 }, () => kiroMemoryOff(home)));
  assert.deepEqual(settings(home), { 'memory.mode': 'disabled', 'memory.reflection': false });
  assert.deepEqual(readdirSync(join(home, 'settings')), ['cli.json']);
});

test('#479: a home Postbox can’t write says so, and what to check', async () => {
  const home = tempDir('postbox-kiro-memory-blocked-');
  writeFileSync(join(home, 'settings'), 'a file where the folder should be');
  await assert.rejects(kiroMemoryOff(home), /couldn’t turn Kiro’s memory off in .*settings.*Check that the folder is yours and writable/s);
});

test('#479: an Isolated persona’s turn runs with memory off; one with your setup leaves your Kiro home alone', async () => {
  const root = tempDir('postbox-kiro-memory-turn-');
  const isolatedHome = join(root, 'postbox-home');
  const yours = join(root, 'your-home');
  mkdirSync(join(yours, 'settings'), { recursive: true });
  writeFileSync(join(yours, 'settings', 'cli.json'), '{"memory.mode":"read_write"}');
  for (const usesHostSetup of [false, true]) {
    const seen = [];
    const adapter = new KiroCliAdapter({
      // Under the test’s folder, as a data folder’s workspaces are: the turn notes its agent file beside it (#1864).
      workRoot: join(root, 'work'),
      isolatedHome,
      env: { KIRO_HOME: yours },
      spawnImpl: /** @type {any} */ (fakeSpawn([{ lines: fixture('first'), code: 0 }], seen)),
    });
    const ctx = fakeCtx();
    ctx.persona = { ...ctx.persona, usesHostSetup };
    await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx);
  }
  assert.equal(settings(isolatedHome)['memory.mode'], 'disabled');
  assert.equal(readFileSync(join(yours, 'settings', 'cli.json'), 'utf8'), '{"memory.mode":"read_write"}');
});
