// #466: a Claude Code turn that couldn’t reach Anthropic’s API fails as a network failure, from the result’s
// structured `api_error: "connection_failed"`, never from its words, so a scheduled wake it ran is retried
// (server/scheduled-wakes.mjs, settleScheduledWake).
//
// The stream is recorded: claude 2.1.318, `claude -p --output-format stream-json --verbose` with
// ANTHROPIC_BASE_URL set to a host under .invalid, which never resolves, so nothing left this computer (27 November
// 2026, peer-checked under the sprint’s §8). Claude Code retried ten times (`api_retry`, error "unknown"), then wrote an
// assistant line and a result, each with `api_error: "connection_failed"`, after about three minutes. Its init line
// (this computer’s paths and tools) is left out, and its ids and times are replaced. The recording covers a name that
// doesn’t resolve (ENOTFOUND); the mark is Claude Code’s own for a connection it couldn’t make, which its retries name
// alike, so a refused or reset connection is read the same way without a recording of its own.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { failureClass, isNetworkFailure } from '../server/harness-failure.mjs';
import { tempDir } from './temp-dirs.mjs';

const RECORDED = readFileSync(new URL('fixtures/claude-code/connection-failed.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const quietCtx = () => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-test-net-'), description: '', instructions: '' },
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
});

/** A claude that plays the lines, then exits 1, as the recorded run did. @param {any[]} lines */
const playing = (lines) => () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
  setImmediate(() => {
    for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
    child.stdout.end();
    setTimeout(() => child.emit('close', 1), 5);
  });
  return child;
};

/** What Claude Code’s adapter throws for the lines. @param {any[]} lines */
async function claudeThrows(lines) {
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-test-net-work-'), spawnImpl: playing(lines) });
  return adapter.deliver({}, { kind: 'user', text: 'Hi' }, quietCtx()).then(
    () => assert.fail('the turn failed'),
    (e) => e,
  );
}

test('#466 Claude Code: a turn that couldn’t reach the API fails as a network failure, with what Claude Code said', async () => {
  const err = await claudeThrows(RECORDED);
  assert.equal(isNetworkFailure(err), true);
  assert.deepEqual(failureClass(err), { kind: 'network' });
  assert.match(err.message, /Can’t reach the API server|Can't reach the API server/);
});

test('#466 Claude Code: an API error that isn’t a connection fails as before, not as a network failure', async () => {
  const lines = RECORDED.map((l) => (l.type === 'result' ? { ...l, api_error: 'invalid_request', result: 'API Error: 400' } : l));
  const err = await claudeThrows(lines);
  assert.equal(isNetworkFailure(err), false);
});
