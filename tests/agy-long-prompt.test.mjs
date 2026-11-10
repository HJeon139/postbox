// #362 item 5: agy takes its prompt as one argument (--print=…), and Linux refuses one argument past 128 KiB (E2BIG),
// so a long wake failed to start with a raw spawn error. agy has no other way in for a prompt that Postbox knows of,
// so past ARG_PROMPT_MAX bytes the turn fails before agy starts, saying how long it was and what to do.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { tempDir } from './temp-dirs.mjs';

const lines = readFileSync(new URL('fixtures/antigravity-cli/block.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

/** A turn's context, with what an adapter reports kept. */
const ctx = () => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [], description: '', instructions: '' },
  project: null,
  handles: ['gem'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
  reported: () => {},
});

/** An adapter whose fake agy plays a recorded turn, and the spawns it saw. */
function adapter() {
  const root = tempDir('pb-agy-long-');
  const spawned = [];
  const spawnImpl = (_bin, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    setImmediate(() => {
      for (const l of lines) child.stdout.write(`${l}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const a = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (spawnImpl),
    env: {},
  });
  return { a, spawned };
}

test('#362: a prompt too long for agy’s --print argument fails with a reason, before agy starts', async () => {
  const { a, spawned } = adapter();
  await assert.rejects(a.deliver({}, { kind: 'user', text: `go ${'x'.repeat(120_000)}` }, ctx()), (e) => {
    assert.match(e.message, /^This message is 1\d\d KB, past the 100 KB the Antigravity CLI can take as its prompt\. Send it in parts/);
    return true;
  });
  assert.equal(spawned.length, 0, 'agy never started');
});

test('#362: the limit counts bytes, and a short prompt, with "<&>" in it, still goes', async () => {
  const { a, spawned } = adapter();
  await assert.rejects(a.deliver({}, { kind: 'user', text: '日'.repeat(40_000) }, ctx()), /past the 100 KB/);
  await a.deliver({}, { kind: 'user', text: 'Tea or coffee? "<&>"' }, ctx());
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].some((x) => x.startsWith('--print=') && x.includes('Tea or coffee? "<&>"')));
});
