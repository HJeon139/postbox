// #1952: each adapter built a CLI's stderr by appending its raw Buffer chunks to a string, so a character whose bytes
// landed in two pipe chunks was decoded half in each and showed as replacement characters in the exit error. Each CLI
// here is a stand-in process at the spawn boundary that writes its stderr one byte at a time and exits with code 1.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { stderrTail } from '../server/adapters/stderr-tail.mjs';
import { tempDir } from './temp-dirs.mjs';

const SAID = 'error: café 😀 failed';

/** A CLI that writes SAID to stderr one byte at a time, then exits with code 1. */
const bytewise = () => {
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => child.emit('spawn'));
  setImmediate(async () => {
    for (const byte of Buffer.from(`${SAID}\n`)) {
      child.stderr.write(Buffer.from([byte]));
      await new Promise((r) => setImmediate(r));
    }
    child.stdout.end();
    child.stderr.end();
    setTimeout(() => child.emit('close', 1), 10);
  });
  return child;
};

const ctx = () => {
  const abort = new AbortController();
  return {
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1',
    persona: { handle: 'coder', model: '', permissionMode: 'auto', tools: [], folder: tempDir('pb-chunks-'), description: '', instructions: '' },
    project: { folder: tempDir('pb-chunks-project-') },
    handles: ['coder'],
    state: {},
    saveState() {},
    pathOf: () => null,
    text() {},
    activity() {},
    status() {},
    checkpoint() {},
    compaction() {},
    denied() {},
  };
};

/** The error a turn fails with. @param {Promise<any>} turn */
const failure = async (turn) => {
  try {
    await turn;
  } catch (e) {
    return String(/** @type {any} */ (e).message);
  }
  return '';
};

const turn = { kind: 'user', text: 'Hi.' };
const root = () => tempDir('pb-chunks-root-');
// Kiro and Antigravity write their turn agent and allow rule under these, never in the real homes.
const adapters = {
  'Claude Code': () => new ClaudeCodeAdapter({ bin: 'claude', workRoot: root(), spawnImpl: bytewise }),
  Codex: () => new CodexAdapter({ workRoot: root(), spawnImpl: bytewise }),
  Kiro: () => {
    const r = root();
    return new KiroCliAdapter({ workRoot: join(r, 'work'), isolatedHome: join(r, 'home'), spawnImpl: bytewise, env: {} });
  },
  Antigravity: () => {
    const r = root();
    return new AntigravityCliAdapter({ workRoot: join(r, 'work'), settingsFile: join(r, 'settings.json'), spawnImpl: bytewise, env: {} });
  },
};

for (const [name, make] of Object.entries(adapters)) {
  test(`#1952 ${name}’s exit error shows a character whose bytes came in separate chunks whole`, async () => {
    const said = await failure(make().deliver({}, turn, ctx()));
    assert.match(said, /exited with code 1/);
    assert.ok(said.includes('café 😀 failed'), said);
    assert.doesNotMatch(said, /�/);
  });
}

test('#1952 the kept stderr is cut on a character, never starting with half of one', async () => {
  const stderr = new PassThrough();
  const kept = stderrTail({ stderr }, 3);
  stderr.write('ab😀cd');
  await new Promise((r) => setImmediate(r));
  // The last three code units start with the emoji’s second half, so the tail keeps two.
  assert.equal(kept(), 'cd');
});
