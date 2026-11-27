// The daemon’s `forget` (server/remote/host/daemon-forget.mjs, #491): a deleted persona’s memory folder,
// ~/.postbox-remote/memory/<persona id>, and its Kiro home, kiro-home/<persona id> (#1661), go, and nothing else
// does; Postbox hears `forgotten`.

import assert from 'node:assert/strict';
import { existsSync, promises as fsp, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { forget } from '../server/remote/host/daemon-forget.mjs';
import { encode, hostPaths, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { inProcessDaemon } from './remote-broker-daemon-setup.mjs';
import { TOKEN, VERSION } from './remote-broker-fixtures.mjs';
import { hostHome } from './socket-base.mjs';

/** A daemon in a temp home, with Postbox said hello: its paths, what it sent, and a send. @param {import('node:test').TestContext} t */
async function daemon(t) {
  const home = hostHome('pbfg-');
  /** @type {string[]} */
  const logs = [];
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const { daemon: d } = inProcessDaemon(home, { log: (/** @type {string} */ l) => logs.push(l) });
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
  return { p, msgs, send, logs, memory: join(p.root, 'memory') };
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

/** An Isolated Kiro persona’s home on the host (#1661), with its memory in it. @param {string} root @param {string} id */
function kiroHome(root, id) {
  mkdirSync(join(root, 'kiro-home', id, 'sessions'), { recursive: true });
  writeFileSync(join(root, 'kiro-home', id, 'sessions', 's.json'), '{}\n');
}

test('#1661 forget removes the persona’s Kiro home too, and no other, with or without a memory folder', async (t) => {
  const { p, msgs, send, memory } = await daemon(t);
  kiroHome(p.root, 'pe_gone');
  kiroHome(p.root, 'pe_stays');
  // A host that never ran Claude Code has no memory/ at all.
  assert.equal(existsSync(memory), false);
  send('forget', { persona: 'pe_gone' });
  assert.deepEqual(await msgs.next('forgotten'), { type: 'forgotten', persona: 'pe_gone' });
  assert.equal(existsSync(join(p.root, 'kiro-home', 'pe_gone')), false);
  assert.equal(existsSync(join(p.root, 'kiro-home', 'pe_stays', 'sessions', 's.json')), true);
  remembered(memory, 'pe_both');
  kiroHome(p.root, 'pe_both');
  send('forget', { persona: 'pe_both' });
  await msgs.next('forgotten');
  assert.equal(existsSync(join(memory, 'pe_both')), false);
  assert.equal(existsSync(join(p.root, 'kiro-home', 'pe_both')), false);
});

test('#1661 a kiro-home/ that is a link isn’t followed: nothing is removed, and Postbox hears why', async (t) => {
  const { p, msgs, send } = await daemon(t);
  const elsewhere = join(p.root, '..', 'elsewhere-kiro');
  mkdirSync(join(elsewhere, 'pe_gone'), { recursive: true });
  writeFileSync(join(elsewhere, 'pe_gone', 'keep'), 'keep\n');
  symlinkSync(elsewhere, join(p.root, 'kiro-home'));
  remembered(join(p.root, 'memory'), 'pe_gone');
  send('forget', { persona: 'pe_gone' });
  const refused = await msgs.next('error');
  assert.equal(refused.persona, 'pe_gone');
  assert.match(refused.message, /kiro-home isn’t a folder/);
  assert.equal(existsSync(join(elsewhere, 'pe_gone', 'keep')), true);
  assert.equal(existsSync(join(p.root, 'memory', 'pe_gone', 'pr_1', 'MEMORY.md')), true, 'its memory folder stays too, until it can all go');
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

test('#491 an id a folder name would change is refused, and nothing is removed', async (t) => {
  const { msgs, send, memory } = await daemon(t);
  // setup.mjs’s personaMemory would make `a.b:c` into `a_b_c`; Postbox’s own ids (newId) never need that.
  remembered(memory, 'a_b_c');
  send('forget', { persona: 'a.b:c' });
  const refused = await msgs.next('error');
  assert.equal(refused.re, 'forget');
  assert.equal(existsSync(join(memory, 'a_b_c', 'pr_1', 'MEMORY.md')), true);
});

test('#491 the handler itself never removes memory/ or anything beside it, whatever reaches it', async (t) => {
  const { p, memory } = await daemon(t);
  remembered(memory, 'pe_stays');
  /** @type {string[]} */
  const out = [];
  const c = /** @type {any} */ ({ closed: false, output: { write: (/** @type {string} */ line) => out.push(line) } });
  const d = /** @type {any} */ ({ p, log: () => {} });
  // Past the wire’s check, as a caller in this process could pass them.
  for (const persona of ['', '..', '.', 'a/b', '../memory', undefined]) await forget(d, c, /** @type {any} */ ({ persona }));
  assert.equal(existsSync(join(memory, 'pe_stays', 'pr_1', 'MEMORY.md')), true);
  assert.equal(out.length, 6);
  assert.ok(
    out.every((l) => JSON.parse(l).type === 'error' && JSON.parse(l).re === 'forget'),
    out.join(''),
  );
});

test('#491 a forget before the hello is refused, and removes nothing', async (t) => {
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
  const memory = join(p.root, 'memory');
  remembered(memory, 'pe_gone');
  const input = new PassThrough();
  const output = new PassThrough();
  d.connect({ input, output });
  const msgs = readMessages(output);
  input.write(encode(message('postbox-to-daemon', 'forget', { persona: 'pe_gone' })));
  assert.equal((await msgs.next('error')).code, 'not-ready');
  assert.equal(existsSync(join(memory, 'pe_gone')), true);
});

test('#491 a memory/ that is a link isn’t followed: nothing is removed, and Postbox hears why', async (t) => {
  const { p, msgs, send, memory } = await daemon(t);
  const elsewhere = join(p.root, '..', 'elsewhere');
  remembered(elsewhere, 'pe_gone');
  symlinkSync(elsewhere, memory);
  send('forget', { persona: 'pe_gone' });
  const refused = await msgs.next('error');
  assert.equal(refused.re, 'forget');
  assert.equal(refused.persona, 'pe_gone', 'the refusal names its persona (#1683)');
  assert.match(refused.message, /isn’t a folder/);
  assert.equal(existsSync(join(elsewhere, 'pe_gone', 'pr_1', 'MEMORY.md')), true);
});

// The two failures the file system can give (#1683): each refusal names its persona, and the daemon’s log keeps it.
for (const [what, method] of [
  ['memory/ can’t be read', 'lstat'],
  ['the folder can’t be removed', 'rm'],
]) {
  test(`#1683 when ${what}, the refusal names its persona and the daemon logs it`, async (t) => {
    const { msgs, send, logs, memory } = await daemon(t);
    remembered(memory, 'pe_gone');
    const real = fsp[method];
    t.mock.method(fsp, method, (/** @type {string} */ path, /** @type {any} */ o) =>
      String(path).startsWith(memory) ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : real(path, o),
    );
    send('forget', { persona: 'pe_gone' });
    const refused = await msgs.next('error');
    assert.deepEqual([refused.re, refused.persona, refused.code], ['forget', 'pe_gone', 'internal']);
    assert.match(refused.message, /permission denied\.$/, 'a sentence, so Postbox’s log line reads on');
    assert.equal(existsSync(join(memory, 'pe_gone', 'pr_1', 'MEMORY.md')), true, 'nothing removed');
    assert.ok(
      logs.some((l) => l.includes('pe_gone') && l.includes('permission denied')),
      logs.join('\n'),
    );
  });
}
