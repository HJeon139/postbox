// #1938: when Codex’s app-server or Claude Code exits, Postbox puts the tail of its stderr into the error the person
// sees. Codex’s cut, `.slice(-500)`, could start between the two halves of a character, and neither adapter cleaned
// what it kept: characters that hide or reorder text and control characters reached the error as written. Each CLI
// here is a stand-in process at the spawn boundary that writes stderr and exits.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { exitError as agyExitError } from '../server/adapters/agy-errors.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { kiroExitError } from '../server/adapters/kiro-errors.mjs';
import { cleanLines } from '../shared/text-parts.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A CLI that writes `stderr` and exits with code 1, before answering anything. @param {string} stderr */
const exits = (stderr) => () => {
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  setImmediate(() => {
    child.stderr.write(stderr);
    child.stdout.end();
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
    persona: { handle: 'coder', model: 'gpt-5.5', permissionMode: 'auto', folder: tempDir('pb-stderr-'), description: '', instructions: '' },
    project: { folder: tempDir('pb-stderr-project-') },
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

const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029]|\p{Cc}/u;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('#1938 Codex’s exit error keeps a whole character at the start of its stderr’s tail, and no hidden characters', async () => {
  const said0 = 'error: \u202Eboom \u200B\u0007done';
  // Cleaning drops two hidden characters and the bell’s extra space, so the emoji’s second half lands 500 characters
  // from the end of the cleaned text, where the tail starts.
  const tail = `${said0}${'y'.repeat(499 - said0.length + 3)}`;
  const stderr = `${'x'.repeat(40)}\u{1F600}${tail}`;
  const said = await failure(
    new CodexAdapter({ workRoot: tempDir('pb-stderr-codex-'), spawnImpl: exits(stderr) }).deliver({}, { kind: 'user', text: 'Hi.' }, ctx()),
  );
  assert.match(said, /exited with code 1/);
  assert.doesNotMatch(said, LONE, 'no half of a character');
  assert.doesNotMatch(said, HIDDEN);
  assert.match(said, /error: boom done/);
});

test('#1938 Claude Code’s exit error shows its stderr’s last lines with no hidden characters', async () => {
  const stderr = 'starting \nError: \u202Eledom\u202C name \u200Binvalid \u0007\n';
  const said = await failure(
    new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-stderr-claude-'), spawnImpl: exits(stderr) }).deliver(
      {},
      { kind: 'user', text: 'Hi.' },
      ctx(),
    ),
  );
  assert.match(said, /exited with code 1: starting Error: ledom name invalid/);
  assert.doesNotMatch(said, HIDDEN);
});

test('#1938 Claude Code’s exit error doesn’t start with half a character when its kept stderr was cut from the end', async () => {
  // One line longer than the 4,000 characters the adapter keeps: what it keeps starts with the emoji’s second half.
  const stderr = `\u{1F600}${'b'.repeat(3999)}`;
  const said = await failure(
    new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-stderr-claude-'), spawnImpl: exits(stderr) }).deliver(
      {},
      { kind: 'user', text: 'Hi.' },
      ctx(),
    ),
  );
  assert.match(said, /exited with code 1: b/);
  assert.doesNotMatch(said, LONE);
});

test('#1938 Codex’s exit error says nothing in brackets when its stderr held only hidden characters', async () => {
  const said = await failure(
    new CodexAdapter({ workRoot: tempDir('pb-stderr-codex-'), spawnImpl: exits('\u202E\u200B\n') }).deliver({}, { kind: 'user', text: 'Hi.' }, ctx()),
  );
  assert.match(said, /exited with code 1/);
  assert.doesNotMatch(said, /\(\s*\)/, 'no empty brackets');
  assert.doesNotMatch(said, HIDDEN);
});

test('#1938 Kiro’s and Antigravity’s exit errors clean their stderr too', () => {
  const stderr = 'error: \u202Emoorb\u202C \u200Bthe \u0007build failed\n';
  assert.equal(kiroExitError(1, stderr), 'Kiro exited with code 1: error: moorb the build failed.');
  assert.equal(agyExitError(2, stderr), 'Antigravity exited with code 2: error: moorb the build failed.');
});

test('#1938 a CLI’s exit error keeps the end of its last lines when they run long, where the newest words are', async () => {
  const stderr = `${'x'.repeat(600)}\nError: the build failed\n`;
  assert.match(kiroExitError(1, stderr), /: x+ Error: the build failed\.$/);
  assert.match(agyExitError(1, stderr), /: x+ Error: the build failed\.$/);
  const said = await failure(
    new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-stderr-claude-'), spawnImpl: exits(stderr) }).deliver(
      {},
      { kind: 'user', text: 'Hi.' },
      ctx(),
    ),
  );
  assert.match(said, /: x+ Error: the build failed\.$/);
});

test('#1938 half a character left alone goes from a CLI’s words and a card’s lines, and two halves an invisible character split don’t join', () => {
  assert.equal(cleanLines('a\uDE00b\n\uD83D\u200B\uDE00c', 99), 'ab\nc');
  assert.equal(kiroExitError(1, 'error: \uD83D\u200B\uDE00x\uD800'), 'Kiro exited with code 1: error: x.');
});
