// The daemon’s `forget` (server/remote/host/daemon-forget.mjs, #491): a deleted persona’s memory folder,
// ~/.postbox-remote/memory/<persona id>, goes, and nothing else does; Postbox hears `forgotten`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { encode, hostPaths, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { inProcessDaemon } from './remote-broker-daemon-setup.mjs';
import { TOKEN, VERSION } from './remote-broker-fixtures.mjs';
import { hostHome } from './socket-base.mjs';

/** A daemon in a temp home, with Postbox said hello: its paths, what it sent, and a send. @param {import('node:test').TestContext} t */
async function daemon(t) {
  const home = hostHome('pbfg-');
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const { daemon: d } = inProcessDaemon(home);
  t.after(async () => {
    d.close();
    await rm(home, { recursive: true, force: true });
  });
  await d.start();
  const input = new PassThrough();
  const output = new PassThrough();
  d.connect({ input, output });
  const msgs = readMessages(output);
  const send = (/** @type {string} */ type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
  send('hello', { version: PROTOCOL_VERSION, token: TOKEN });
  await msgs.next('welcome');
  return { p, msgs, send, memory: join(p.root, 'memory') };
}

/** A persona’s memory folder with a project’s file in it. @param {string} memory @param {string} id */
function remembered(memory, id) {
  mkdirSync(join(memory, id, 'pr_1'), { recursive: true });
  writeFileSync(join(memory, id, 'pr_1', 'MEMORY.md'), '- remembered\n');
}

test('#491 forget removes the persona’s memory folder and no other', async (t) => {
  const { msgs, send, memory } = await daemon(t);
  remembered(memory, 'pe_gone');
  remembered(memory, 'pe_stays');
  send('forget', { persona: 'pe_gone' });
  assert.deepEqual(await msgs.next('forgotten'), { type: 'forgotten', persona: 'pe_gone' });
  assert.equal(existsSync(join(memory, 'pe_gone')), false);
  assert.equal(existsSync(join(memory, 'pe_stays', 'pr_1', 'MEMORY.md')), true);
});

test('#491 a persona with no memory there, or a host with no memory folder, is forgotten all the same', async (t) => {
  const { msgs, send, memory } = await daemon(t);
  send('forget', { persona: 'pe_never' });
  assert.deepEqual(await msgs.next('forgotten'), { type: 'forgotten', persona: 'pe_never' });
  remembered(memory, 'pe_stays');
  send('forget', { persona: 'pe_never' });
  await msgs.next('forgotten');
  assert.equal(existsSync(join(memory, 'pe_stays')), true);
});

test('#491 an id with characters a folder name replaces names the folder Postbox made, inside memory/', async (t) => {
  const { msgs, send, memory } = await daemon(t);
  // setup.mjs’s personaMemory makes `a.b:c` into `a_b_c`.
  remembered(memory, 'a_b_c');
  remembered(memory, 'a');
  send('forget', { persona: 'a.b:c' });
  await msgs.next('forgotten');
  assert.equal(existsSync(join(memory, 'a_b_c')), false);
  assert.equal(existsSync(join(memory, 'a', 'pr_1', 'MEMORY.md')), true, 'nothing beside it');
});

test('#491 a memory/ that is a link isn’t followed: nothing is removed, and Postbox hears why', async (t) => {
  const { p, msgs, send, memory } = await daemon(t);
  const elsewhere = join(p.root, '..', 'elsewhere');
  remembered(elsewhere, 'pe_gone');
  symlinkSync(elsewhere, memory);
  send('forget', { persona: 'pe_gone' });
  const refused = await msgs.next('error');
  assert.equal(refused.re, 'forget');
  assert.match(refused.message, /isn’t a folder/);
  assert.equal(existsSync(join(elsewhere, 'pe_gone', 'pr_1', 'MEMORY.md')), true);
});
