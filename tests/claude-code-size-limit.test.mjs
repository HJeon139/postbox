// #674: a Claude Code session whose request is too large to cut down fails every turn that resumes it, Retry included,
// since Claude Code says the conversation can’t go on. Postbox starts it over once in a fresh session, as #544 does for
// Kiro’s (tests/kiro-size-limit.test.mjs).
//
// Reconstructed, not recorded: no turn has been recorded hitting it. The words are claude 2.1.318’s own, read from its
// binary (the headless branch of the message it gives a request it classifies as "unrecoverable", the body without its
// media still over the byte limit). The lines’ shape is the recorded API error of tests/fixtures/claude-code/
// connection-failed.jsonl (claude 2.1.318): its assistant line marked is_api_error_message, then its result, with
// is_error true, both carrying the error’s words. Its api_error is cleared (its api_error_status is already null), since
// what Claude Code puts there for this error isn’t known.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { overSizeLimit } from '../server/adapters/claude-result.mjs';
import { isNetworkFailure } from '../server/harness-failure.mjs';
import { forbidden, remoteCtx, starts } from './claude-code-remote-fixture.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { tempDir } from './temp-dirs.mjs';

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const DEAD_END = 'Reduce the input (large tool results or pasted content) or start a new session; this conversation cannot continue as is.';

/** The recorded API error’s assistant line and result, saying the dead end. @param {string} sessionId */
function tooLarge(sessionId) {
  const [said, result] = fixture('connection-failed').slice(-2);
  return [
    { ...said, session_id: sessionId, api_error: null, message: { ...said.message, content: [{ type: 'text', text: `API Error: ${DEAD_END}` }] } },
    { ...result, session_id: sessionId, api_error: null, result: `API Error: ${DEAD_END}` },
  ];
}

/** A turn context that records what the adapter saved and said. @param {any} state */
function fakeCtx(state = {}) {
  const calls = { text: '', saved: /** @type {Record<string, any>} */ ({}) };
  return {
    calls,
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-test-size-'), description: '', instructions: '' },
    project: null,
    handles: ['coder'],
    state,
    saveState: (/** @type {any} */ p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (/** @type {string} */ d) => {
      calls.text += d;
    },
    activity: () => {},
    status: () => {},
    compaction: () => {},
    denied: () => {},
  };
}

/** A claude for each run that plays its lines, then exits with its code. @param {{ lines: any[], code?: number }[]} plays */
function playing(plays) {
  const runs = /** @type {{ args: string[], stdin: PassThrough }[]} */ ([]);
  const spawnImpl = (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    const play = plays[runs.length] ?? { lines: [], code: 1 };
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
    runs.push({ args, stdin: child.stdin });
    setImmediate(() => {
      for (const l of play.lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', play.code ?? 0), 5);
    });
    return child;
  };
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-test-size-work-'), spawnImpl: /** @type {any} */ (spawnImpl) });
  return { adapter, runs };
}

const argAfter = (/** @type {string[]} */ args, /** @type {string} */ flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

test('#674: Claude Code’s dead end is told from its other errors', () => {
  assert.equal(overSizeLimit(tooLarge('s').at(-1).result), true);
  for (const name of ['connection-failed', 'resume-missing', 'fork-point-missing']) {
    const result = fixture(name).at(-1);
    assert.equal(overSizeLimit([result.result, ...(result.errors ?? [])].join('\n')), false, name);
  }
});

test('#674: a resumed Claude Code session too large to go on starts over once in a fresh session, and says why', async () => {
  const { adapter, runs } = playing([
    { lines: tooLarge('sess-big'), code: 1 },
    { lines: fixture('block'), code: 0 },
  ]);
  const ctx = fakeCtx({ claudeSessionId: 'sess-big' });
  await adapter.deliver({}, { kind: 'user', text: 'Hello again' }, ctx);
  assert.equal(runs.length, 2, 'one fresh start');
  assert.equal(argAfter(runs[0].args, '--resume'), 'sess-big');
  assert.ok(!runs[1].args.includes('--resume'), 'the fresh run resumes nothing');
  const fresh = argAfter(runs[1].args, '--session-id');
  assert.ok(fresh && fresh !== 'sess-big');
  const sent = String(runs[1].stdin.read());
  assert.match(sent, /^\[Postbox\] .*too large for Claude Code.*fresh start/);
  assert.match(sent, /Hello again/, 'the message itself is sent again');
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  assert.notEqual(ctx.calls.saved.claudeSessionId, 'sess-big', 'the oversized session isn’t resumed again');
});

test('#674: a thread forked from a session too large to go on starts over once, forgets the fork, and keeps no checkpoint', async () => {
  // The fork's own session, as the recorded init line names it, so a checkpoint would name the fork.
  const init = { ...fixture('block')[0], session_id: 'sess-fork' };
  const { adapter, runs } = playing([
    { lines: [init, ...tooLarge('sess-fork')], code: 1 },
    { lines: fixture('block'), code: 0 },
  ]);
  const ctx = fakeCtx({ forkFrom: { claudeSessionId: 'sess-big' } });
  const checkpoints = /** @type {any[]} */ ([]);
  Object.assign(ctx, { checkpoint: (/** @type {any} */ c) => checkpoints.push(c) });
  await adapter.deliver({}, { kind: 'user', text: 'Hello again' }, ctx);
  assert.equal(runs.length, 2, 'one fresh start');
  assert.equal(argAfter(runs[0].args, '--resume'), 'sess-big');
  assert.ok(runs[0].args.includes('--fork-session'), 'the first run forked the oversized conversation');
  assert.ok(!runs[1].args.includes('--resume') && !runs[1].args.includes('--fork-session'), 'the fresh run forks nothing');
  assert.equal(ctx.calls.saved.forkFrom, null, 'the next turn doesn’t fork it again');
  assert.ok(!checkpoints.some((c) => c.claudeSessionId === 'sess-fork'), 'no thread can branch into the oversized fork');
});

test('#674: a fresh Claude Code session still too large fails with Claude Code’s words, and isn’t kept to resume', async () => {
  const { adapter, runs } = playing([
    { lines: tooLarge('sess-big'), code: 1 },
    { lines: tooLarge('sess-new'), code: 1 },
  ]);
  const ctx = fakeCtx({ claudeSessionId: 'sess-big' });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hello again' }, ctx), /this conversation cannot continue as is/);
  assert.equal(runs.length, 2, 'one fresh start, not a loop');
  assert.equal(ctx.calls.saved.claudeSessionId, null, 'the next turn starts fresh instead of resuming it');
});

test('#674: a Claude Code run that resumed nothing and is too large fails once, and keeps no session', async () => {
  const { adapter, runs } = playing([{ lines: tooLarge('sess-new'), code: 1 }]);
  const ctx = fakeCtx();
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx), /this conversation cannot continue as is/);
  assert.equal(runs.length, 1, 'no start-over for a run that resumed nothing');
  assert.equal(ctx.calls.saved.claudeSessionId, null);
});

test('#674: a resumed Claude Code session’s other errors, and a reply that quotes the dead end, run once as before', async () => {
  const network = playing([{ lines: fixture('connection-failed'), code: 1 }]);
  const ctx = fakeCtx({ claudeSessionId: 'sess-1' });
  const err = await network.adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx).then(
    () => assert.fail('the turn failed'),
    (e) => e,
  );
  assert.equal(network.runs.length, 1);
  assert.equal(isNetworkFailure(err), true, 'still a network failure');
  assert.notEqual(ctx.calls.saved.claudeSessionId, null, 'its session is kept');
  // A turn that worked, whose reply happens to quote the words, stands.
  const block = fixture('block');
  const quoted = { ...block.at(-1), result: `Claude Code says “${DEAD_END}”` };
  const ok = playing([{ lines: [...block.slice(0, -1), quoted], code: 0 }]);
  const okCtx = fakeCtx({ claudeSessionId: 'sess-1' });
  await ok.adapter.deliver({}, { kind: 'user', text: 'What does it say?' }, okCtx);
  assert.equal(ok.runs.length, 1);
  assert.notEqual(okCtx.calls.saved.claudeSessionId, null);
});

test('#674: a remote Claude Code turn replayed after a restart that ended too large fails, and its session isn’t kept', async () => {
  const d = createFakeDaemon({ lines: [], autoEnd: false });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-test-size-work-'), ...forbidden() });
  const ctx = remoteCtx(d, { state: { claudeSessionId: 'sess-big' }, remote: { attach: { turn: 'tr-big' } } });
  d.addTurn('tr-big', { lines: tooLarge('sess-big').map((l) => JSON.stringify(l)), exit: { code: 1, signal: null } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'not sent again' }, ctx), /this conversation cannot continue as is/);
  assert.equal(starts(d).length, 0, 'an attach starts nothing');
  assert.equal(ctx.calls.saved.claudeSessionId, null);
});
