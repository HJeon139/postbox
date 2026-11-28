// A Codex turn that fails with its reason only in turn/completed gives that reason (#425). The shapes are Codex
// 0.167.0’s (`codex app-server generate-json-schema`): TurnCompletedNotification { threadId, turn }, where a failed
// turn’s `error` is a TurnError { message, codexErrorInfo?, additionalDetails? }. No recording in
// tests/fixtures/codex-app-server has a turn that failed this way, so these follow the schema.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';

/**
 * turn/start’s answer, then the turn’s end as failed, after the notices given (none: no error notification before it).
 * @param {any} error  the turn’s TurnError @param {any[]} [notices]
 */
const failsWith =
  (error, notices = []) =>
  (/** @type {any} */ child, /** @type {() => void} */ answer) => {
    answer();
    const turn = { id: 'turn_fake', status: 'failed', error };
    const lines = [...notices, { method: 'turn/completed', params: { threadId: 'thr_fake', turn } }];
    setImmediate(() => {
      for (const m of lines) child.stdout.write(`${JSON.stringify(m)}\n`);
    });
  };

/** A turn’s context. */
function context() {
  return {
    persona: { handle: 'gpt', model: 'auto', permissionMode: 'auto' },
    project: { folder: `${CODEX_ROOT}/project` },
    handles: ['gpt'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };
}

test('#425 a Codex turn that fails with its reason only in turn/completed fails with that reason, not just “Codex turn failed.”', async () => {
  const error = { message: 'Your input exceeds the context window of this model.', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null };
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer([], { hold: true, beforeStarted: failsWith(error) }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, context()), {
    message: 'Codex turn failed: Your input exceeds the context window of this model.',
  });
});

test('#425 a failed Codex turn with no reason anywhere still says it failed', async () => {
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer([], { hold: true, beforeStarted: failsWith(null) }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, context()), { message: 'Codex turn failed.' });
});

test('#425 a failed Codex turn keeps the reason its error notification gave, as before', async () => {
  const notice = { method: 'error', params: { error: { message: 'The model gpt-nope does not exist.' }, willRetry: false } };
  const notifiedFirst = failsWith({ message: 'Turn failed.' }, [notice]);
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer([], { hold: true, beforeStarted: notifiedFirst }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, context()), { message: 'Codex turn failed: The model gpt-nope does not exist.' });
});

test('#425 what Codex says of a failed turn reaches the person cleaned and cut, from turn/completed or an error notification', async () => {
  const said = `Bad\u202Egnp.exe\nsecond line ${'x'.repeat(600)}`;
  const notice = { method: 'error', params: { error: { message: said }, willRetry: false } };
  /** The error notification before turn/start’s answer, so it rejects that request itself. */
  const notifiedBeforeAnswer = (/** @type {any} */ child) => child.stdout.write(`${JSON.stringify(notice)}\n`);
  for (const end of [failsWith({ message: said }), failsWith({ message: 'Turn failed.' }, [notice]), notifiedBeforeAnswer]) {
    const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer([], { hold: true, beforeStarted: end }) });
    const err = await adapter.deliver({}, { kind: 'user', text: 'Hi' }, context()).then(
      () => assert.fail('the turn should fail'),
      (/** @type {any} */ e) => e,
    );
    assert.match(err.message, /^(Codex turn failed: )?Bad/);
    assert.doesNotMatch(err.message, /[\u202E\n]/, 'no bidi override or line break');
    assert.ok(err.message.length <= 'Codex turn failed: '.length + 400, `cut to 400 characters, not ${err.message.length}`);
  }
});

test('#425 a request Codex refuses reaches the person cleaned and cut, with its code kept', async () => {
  const message = `Bad\u202Egnp.exe\nsecond line ${'x'.repeat(600)}`;
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer([], { threadError: () => ({ code: -32603, message }) }) });
  const err = await adapter.deliver({}, { kind: 'user', text: 'Hi' }, context()).then(
    () => assert.fail('the turn should fail'),
    (/** @type {any} */ e) => e,
  );
  assert.match(err.message, /^Bad/);
  assert.doesNotMatch(err.message, /[\u202E\n]/, 'no bidi override or line break');
  assert.ok(err.message.length <= 400, `cut to 400 characters, not ${err.message.length}`);
  assert.equal(err.code, -32603, 'its JSON-RPC code, for how the failure is classed');
  assert.equal(err.cause?.message, message, 'Codex’s own words kept as the cause');
});

test('#425 an error with no JSON-RPC code passes the turn’s edge as it was, so Postbox’s own marks on it stay', async () => {
  const { codexSaid } = await import('../server/adapters/codex-thread.mjs');
  const own = Object.assign(new Error('Postbox’s tools didn’t load.'), { notReached: true });
  assert.equal(codexSaid(own), own);
});

test('#425 a failed Codex turn whose reason isn’t text still ends, with no reason made up', async () => {
  const notice = { method: 'error', params: { error: { message: { text: 'structured' } }, willRetry: false } };
  for (const end of [failsWith({ message: { text: 'structured' } }), failsWith(null, [notice])]) {
    const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer([], { hold: true, beforeStarted: end }) });
    await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, context()), { message: /^Codex turn failed/ });
  }
});

test('#425 Codex’s words when it can’t list its MCP servers reach the person cleaned and cut', async () => {
  const { codexMcpApprovalConfig } = await import('../server/adapters/codex-mcp-policy.mjs');
  const request = async () => {
    throw new Error(`Bad‮gnp.exe\nsecond line ${'x'.repeat(600)}`);
  };
  await assert.rejects(codexMcpApprovalConfig(request, 'ask'), (/** @type {any} */ error) => {
    assert.match(error.message, /to them: Bad/);
    assert.doesNotMatch(error.message, /[‮\n]/, 'no bidi override or line break');
    assert.ok(error.message.length <= 'Codex couldn’t list its MCP servers, so Postbox can’t apply this permission mode to them: '.length + 400);
    return true;
  });
});
