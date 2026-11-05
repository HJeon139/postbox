// A Kiro session grown past the request size limit fails every turn that resumes it, Retry included (#544).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createKiroMapper, KiroCliAdapter, kiroAgent } from '../server/adapters/kiro-cli.mjs';
import { overSizeLimit } from '../server/adapters/kiro-errors.mjs';
import { fakeCtx, fakeSpawn, fixture } from './kiro-cli-fakes.mjs';
import { setup } from './kiro-cli-remote-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

// Reconstructed, not recorded: the message is the one #544 quotes from a real turn (Postbox v0.44.7; the issue
// doesn’t name the Kiro version), and the event’s shape is the recorded missing-session.jsonl’s, without a `stage`,
// which the issue doesn’t give. Every recorded runError carries only sessionId, stage and message, so the error is
// told by its text: -32000 and GenericValidationError, inside the message, aren’t particular to size. kiro-cli 2.37.1
// didn’t reproduce it (over-threshold-recovered.jsonl, below).
const SIZE_LIMIT = 'Request exceeds the maximum allowed size (code -32000): {"errorType":"GenericValidationError","retryErrorType":"CLIENT_ERROR"}';
const tooLarge = (sessionId) => [
  { type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v3' } },
  { type: 'runError', data: { sessionId, message: SIZE_LIMIT } },
];

const adapterWith = (streams, seen) => {
  const root = tempDir('pb-kiro-');
  return new KiroCliAdapter({
    workRoot: join(root, 'work'),
    isolatedHome: join(root, 'home'),
    spawnImpl: /** @type {any} */ (fakeSpawn(streams, seen)),
    env: {},
  });
};

test('#544: the run error of a request over the size limit is told from other run errors', () => {
  const m = createKiroMapper(fakeCtx());
  for (const e of tooLarge('sess_big')) m.push(e);
  assert.equal(overSizeLimit(m.error), true);
  assert.equal(m.missingSession, false);
  for (const name of ['agent-missing', 'missing-session', 'mcp-failed']) {
    const other = createKiroMapper(fakeCtx());
    for (const e of fixture(name)) other.push(e);
    assert.equal(overSizeLimit(other.error), false, name);
  }
});

test('#544: a session over the size limit starts over once, without --resume-id, and says why', async () => {
  const seen = [];
  const adapter = adapterWith(
    [
      { lines: tooLarge('sess_big'), code: 1 },
      { lines: fixture('first'), code: 0 },
    ],
    seen,
  );
  const ctx = fakeCtx({ state: { kiroSessionId: 'sess_big' } });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].args.slice(seen[0].args.indexOf('--resume-id'), seen[0].args.indexOf('--resume-id') + 2), ['--resume-id', 'sess_big']);
  assert.ok(!seen[1].args.includes('--resume-id'));
  assert.match(seen[1].args.at(-1), /^\[Postbox\] .*request size limit.*fresh start/);
  assert.match(seen[1].args.at(-1), /\bhi\b/, 'the request itself is sent again');
  assert.match(ctx.calls.saved.kiroSessionId, /^sess_/);
  assert.notEqual(ctx.calls.saved.kiroSessionId, 'sess_big');
});

// Recorded on 2 November 2026 (kiro-cli 2.37.1, engine v3, your setup), with local paths, steering and skill file
// names and the slash command list removed: a resumed session read 8 more 9.7 MB images. Kiro’s stderr had an
// HTTP 400 “Input content length exceeds threshold”, and Kiro recovered on its own: the stream shows no error.
test('#544: a turn Kiro recovered from on its own (recorded) runs once, and keeps its session', async () => {
  const seen = [];
  const adapter = adapterWith([{ lines: fixture('over-threshold-recovered'), code: 0 }], seen);
  const ctx = fakeCtx({ state: { kiroSessionId: 'sess_8d3630b2-acc1-4d1b-a105-5d6d8339b417' } });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.equal(seen.length, 1, 'no fresh start');
  assert.equal(ctx.calls.saved.kiroSessionId, undefined, 'the session it resumed is kept');
  assert.equal(ctx.calls.text, 'OK');
});

test('#544: the oversized session is cleared before the fresh start, so a fresh run that fails another way doesn’t keep it', async () => {
  const seen = [];
  // The fresh run’s CLI dies before its first line: no output, exit 1.
  const adapter = adapterWith(
    [
      { lines: tooLarge('sess_big'), code: 1 },
      { lines: [], code: 1 },
    ],
    seen,
  );
  const ctx = fakeCtx({ state: { kiroSessionId: 'sess_big' } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx), /Kiro exited with code 1/);
  assert.equal(seen.length, 2);
  assert.equal(ctx.calls.saved.kiroSessionId, null);
});

test('#544: a fresh session over the limit too fails with what Kiro said, and isn’t kept to resume', async () => {
  const seen = [];
  const adapter = adapterWith(
    [
      { lines: tooLarge('sess_big'), code: 1 },
      { lines: tooLarge('sess_new'), code: 1 },
    ],
    seen,
  );
  const ctx = fakeCtx({ state: { kiroSessionId: 'sess_big' } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx), /Kiro couldn’t run the turn: Request exceeds the maximum allowed size/);
  assert.equal(seen.length, 2, 'one fresh start, not a loop');
  assert.equal(ctx.calls.saved.kiroSessionId, null);
});

test('#544: Kiro agents are told to read large files and images a few at a time', () => {
  const persona = { handle: 'kiro', model: 'claude-opus-5-5', usesHostSetup: false, tools: [] };
  assert.match(kiroAgent({ name: 'x', persona, mcpUrl: '', guide: '', folders: [] }).prompt, /request size limit.*a few at a time/s);
});

test('#544: a remote turn replayed after a restart that ended over the limit fails, and its session isn’t kept', async () => {
  const { d, adapter, ctx, calls } = await setup({ state: { kiroSessionId: 'sess_big' }, remote: { attach: { turn: 'tr-big' } } });
  d.addTurn('tr-big', { harness: 'kiro-cli', lines: tooLarge('sess_big').map((e) => JSON.stringify(e)), exit: { code: 1, signal: null } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'not sent again' }, ctx), /Request exceeds the maximum allowed size/);
  assert.equal(d.received.filter((m) => m.type === 'start').length, 0, 'an attach starts nothing');
  assert.equal(calls.saved.kiroSessionId, null);
});
