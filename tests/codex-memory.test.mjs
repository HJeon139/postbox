// #479: Codex keeps its memories in the Codex home, beside the person’s sign-in, so every persona on Codex would read
// and write the person’s memories, and each other’s. Each turn’s app-server, on this computer and on a host, turns them
// off. Checked with codex-cli 0.167.0: config/read on `codex app-server -c memories.use_memories=false -c
// memories.generate_memories=false` reports both false, from the sessionFlags layer; with neither, memories is unset.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexConfigArgs } from '../server/adapters/codex.mjs';
import { codexRemoteConfigArgs } from '../server/adapters/codex-remote.mjs';

const OFF = ['-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false'];

/** Whether `args` holds `want` in order, side by side. */
const holds = (/** @type {string[]} */ args, /** @type {string[]} */ want) => args.some((_, i) => want.every((w, j) => args[i + j] === w));

test('#479: a Codex turn on this computer neither reads nor writes Codex memories', () => {
  assert.ok(holds(codexConfigArgs('http://127.0.0.1:4173/mcp?session=s1'), OFF));
});

test('#479: a Codex turn on a host neither reads nor writes Codex memories', () => {
  assert.ok(holds(codexRemoteConfigArgs('/usr/bin/node', ['/home/user/shim.mjs', 'turn-1'], 60_000), OFF));
});
