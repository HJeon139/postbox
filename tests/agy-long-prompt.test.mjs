// #362 item 5: agy takes its prompt as one argument (--print=…), and how long that can be is the operating system’s to
// say: Linux refuses one past 128 KiB and macOS about 1 MiB, both with E2BIG. So Postbox sets no limit of its own, and
// turns a real E2BIG into what the person can act on. tests/process/agy-long-prompt.test.mjs runs a real spawn.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { agyTurnLines, tooLongMessage, turnContext } from './agy-long-prompt-fixture.mjs';
import { settle } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const errno = (code) => Object.assign(new Error(`spawn ${code}`), { code, syscall: 'spawn' });

/** @param {(args: string[]) => any} spawnImpl */
function adapterWith(spawnImpl) {
  const root = tempDir('pb-agy-long-');
  return new AntigravityCliAdapter({
    bin: 'agy',
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ ((_bin, args) => spawnImpl(args)),
    env: {},
  });
}

const fakeChild = () => {
  const child = new EventEmitter();
  return Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
};

/** An adapter whose fake agy plays a recorded turn, and the spawns it saw. */
function playing() {
  const spawned = [];
  const a = adapterWith((args) => {
    spawned.push(args);
    const child = fakeChild();
    setImmediate(() => {
      for (const l of agyTurnLines()) child.stdout.write(`${l}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  });
  return { a, spawned };
}

const printArg = (args) => args.find((x) => x.startsWith('--print='));

for (const [what, text] of [
  ['120 KB', 'x'.repeat(120_000)],
  ['400 KB', 'x'.repeat(400_000)],
  ['40,000 three-byte characters', '日'.repeat(40_000)],
])
  test(`#362: a prompt of ${what} is agy’s to take, with no limit of Postbox’s own`, async () => {
    const { a, spawned } = playing();
    await a.deliver({}, { kind: 'user', text }, turnContext());
    assert.equal(spawned.length, 1);
    assert.ok(printArg(spawned[0]).includes(text), 'the whole prompt reached the argument');
  });

test('#362: a short prompt, with "<&>" in it, goes as it was written', async () => {
  const { a, spawned } = playing();
  await a.deliver({}, { kind: 'user', text: 'Tea or coffee? "<&>"' }, turnContext());
  assert.ok(printArg(spawned[0]).includes('Tea or coffee? "<&>"'));
});

test('#362: an E2BIG thrown by the spawn, as Node throws it, tells the person the size and what to do', async () => {
  const a = adapterWith(() => {
    throw errno('E2BIG');
  });
  await assert.rejects(a.deliver({}, { kind: 'user', text: 'x'.repeat(140_000) }, turnContext()), (e) => {
    assert.match(e.message, /^This turn’s prompt came to 1\d\d KB, too long for this computer to pass to the Antigravity CLI\./);
    assert.equal(e.cause.code, 'E2BIG', 'the reason is kept');
    return true;
  });
});

test('#362: an E2BIG reported as the child’s error event tells the person the same', async () => {
  const a = adapterWith(() => {
    const child = fakeChild();
    setImmediate(() => child.emit('error', errno('E2BIG')));
    return child;
  });
  await assert.rejects(a.deliver({}, { kind: 'user', text: 'x'.repeat(2_000) }, turnContext()), { message: tooLongMessage(2) });
});

test('#362: a spawn that fails for another reason doesn’t blame the prompt’s length', async () => {
  const a = adapterWith(() => {
    throw errno('EAGAIN');
  });
  await assert.rejects(a.deliver({}, { kind: 'user', text: 'x'.repeat(140_000) }, turnContext()), {
    message: 'Couldn’t start the Antigravity CLI (agy): spawn EAGAIN',
  });
});

test('#362: a turn the operating system refused ends failed with the person’s message, and what was queued stays', async () => {
  const root = tempDir('pb-agy-long-room-');
  const adapter = new AntigravityCliAdapter({
    bin: 'agy',
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: () => {
      throw errno('E2BIG');
    },
    env: {},
  });
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: root });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'bypass' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  rt.sendMessage(t.id, { text: `@gem ${'x'.repeat(40_000)}` });
  rt.sendMessage(t.id, { text: '@gem and this, next' });
  assert.equal(store.state.threads[t.id].queue?.length, 1, 'the second message waits for the first turn');
  await settle(rt);
  const failed = store.items(t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  assert.equal(failed?.error, tooLongMessage(41));
  assert.equal(store.state.sessions[se.id].state, 'failed');
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.text),
    ['@gem and this, next'],
  );
});
