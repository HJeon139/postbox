// A prompt given on stdin is recorded (ctx.prompt, server/turn-prompt.mjs) only once the write to the CLI succeeded: a
// CLI that exits before it reads it (EPIPE) got no prompt, so no turn.prompt says it did (hydrant-critic’s review of
// #1522). Kiro takes a long prompt on stdin (#362), Claude Code takes every prompt there. The pipe fails as Node’s
// does when its other end has gone, as tests/kiro-long-prompt.test.mjs makes it; nothing waits on a timer.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fakeSpawn, fixture } from './kiro-cli-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A stdin whose write fails asynchronously with EPIPE, as a pipe whose reader has exited, and whose end never finishes. */
function brokenStdin() {
  const input = new PassThrough();
  input.end = () => {
    setImmediate(() => input.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    return input;
  };
  return input;
}

test('Kiro records no prompt when it exits before reading a long prompt’s stdin', async () => {
  const root = tempDir('pb-epipe-kiro-');
  const play = fakeSpawn([{ lines: fixture('first'), code: 0 }], []);
  const spawnImpl = (bin, args, opts) => Object.assign(play(bin, args, opts), { stdin: brokenStdin() });
  const adapter = new KiroCliAdapter({ workRoot: join(root, 'work'), isolatedHome: join(root, 'home'), spawnImpl: /** @type {any} */ (spawnImpl), env: {} });
  const recorded = [];
  await adapter.deliver({}, { kind: 'user', text: 'y'.repeat(120_000) }, fakeCtx({ prompt: (p) => recorded.push(p) }));
  assert.deepEqual(recorded, []);
});

test('Claude Code records no prompt when it exits before reading its stdin', async () => {
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: brokenStdin(), pid: 1, kill: () => {} });
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end('');
      setImmediate(() => child.emit('close', 1));
    });
    return child;
  };
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-epipe-work-'), spawnImpl });
  const recorded = [];
  const ctx = {
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-epipe-coder-'), description: '', instructions: '' },
    project: null,
    handles: ['coder'],
    state: {},
    saveState: () => {},
    pathOf: () => null,
    text: () => {},
    activity: () => {},
    status: () => {},
    compaction: () => {},
    denied: () => {},
    prompt: (p) => recorded.push(p),
  };
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx).catch(() => {});
  assert.deepEqual(recorded, []);
});
