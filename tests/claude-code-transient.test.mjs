// #1713: a turn Anthropic’s API failed for a while (529 Overloaded) is marked as one that passes, from the result’s
// structured `api_error_status`, never from its words, by Claude Code’s adapter.
//
// No recorded turn has been overloaded yet, so its stream is built from a recorded one: model-effort.jsonl (claude
// 2.1.296, tests/claude-code.test.mjs), its init line and its result line, which carries `api_error_status: null` as
// recorded. The result keeps every other field, and takes what an API error sets: `is_error`, the status, and the
// text Claude Code writes for it. The status’s type is the CLI’s own (2.1.318’s bundle declares
// `api_error_status: int().nullable().optional()` on a result); the overloaded request has no reply, so the assistant
// and tool lines between go.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { failureClass } from '../server/harness-failure.mjs';
import { tempDir } from './temp-dirs.mjs';

const RECORDED = readFileSync(new URL('fixtures/claude-code/model-effort.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

/** The recorded init and result, the result failed with the API’s status. @param {number} status @param {string} text */
function failedWith(status, text) {
  const init = RECORDED.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = RECORDED.find((e) => e.type === 'result');
  assert.equal(Object.hasOwn(result, 'api_error_status'), true, 'the recorded result carries the field');
  return [init, { ...result, is_error: true, api_error_status: status, result: text, stop_reason: null }];
}
const OVERLOADED = failedWith(529, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');

/** A turn context whose callbacks do nothing, as tests/claude-code.test.mjs’s fakeCtx. */
const quietCtx = () => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-test-529-'), description: '', instructions: '' },
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

/** A claude that plays the lines, then exits 0, as Claude Code does after an error result. @param {any[]} lines */
const playing = (lines) => () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
  setImmediate(() => {
    for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
    child.stdout.end();
    setTimeout(() => child.emit('close', 0), 5);
  });
  return child;
};

/** What Claude Code’s adapter throws for the lines. @param {any[]} lines */
async function claudeThrows(lines) {
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-test-529-work-'), spawnImpl: playing(lines) });
  return adapter.deliver({}, { kind: 'user', text: 'Hi' }, quietCtx()).then(
    () => assert.fail('the turn failed'),
    (e) => e,
  );
}

test('#1713 Claude Code: a result the API overloaded (529) fails the turn as one that passes, with what the API said', async () => {
  const err = await claudeThrows(OVERLOADED);
  assert.deepEqual(failureClass(err), { kind: 'transient', status: 529 });
  assert.match(err.message, /^API Error: 529/);
});

test('#1713 Claude Code: a result the API refused as a bad request (400) fails the turn as before, not as one that passes', async () => {
  const err = await claudeThrows(failedWith(400, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}'));
  assert.match(err.message, /^API Error: 400/, 'the result’s own failure');
  assert.equal(failureClass(err), null);
});
