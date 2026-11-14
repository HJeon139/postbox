// The model a Codex turn names (#120): only one Codex runs, so a Claude model, auto or the mock names none. Apart from
// tests/codex.test.mjs, which is at its length ceiling.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexAdapter, codexModelOf } from '../server/adapters/codex.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';

test('Codex is sent only a model it runs: auto, the mock and Claude’s models name none, so Codex uses its own default (#120)', () => {
  assert.equal(codexModelOf({ model: 'gpt-5.6-terra' }), 'gpt-5.6-terra');
  for (const model of ['auto', 'mock', 'claude-opus-5-5', 'claude-haiku-5-5', '', undefined]) assert.equal(codexModelOf({ model }), null, String(model));
  // The model field offers auto after what the CLI lists, and alone with no list (Codex only on a host), never
  // falling back to Claude’s models.
  assert.deepEqual(new CodexAdapter({ workRoot: '/nowhere', models: ['gpt-5.6-terra'] }).capabilities.models, ['gpt-5.6-terra', 'auto']);
  assert.deepEqual(new CodexAdapter({ workRoot: '/nowhere' }).capabilities.models, ['auto']);
});

test('a Codex persona with Claude’s default model (made before Postbox had Codex’s list) starts its thread and turn naming no model', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer(seen) });
  const reported = [];
  const ctx = {
    persona: { handle: 'critic', model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'acceptEdits' },
    project: { folder: `${CODEX_ROOT}/project` },
    handles: ['critic'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    reported: (r) => reported.push(r),
    pathOf: () => null,
  };
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  assert.ok(!('model' in seen.find((x) => x.method === 'thread/start').params));
  assert.ok(!('model' in seen.find((x) => x.method === 'turn/start').params));
  assert.deepEqual(reported, [{ effort: 'medium' }], 'no model to report when Codex names none');
});

/** An app-server that answers with a recorded Codex 0.167.0 turn (tests/fixtures/codex-app-server/thread-model.jsonl). */
function recordedServer(seen) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => child.emit('close', 0);
  const lines = readFileSync(new URL('fixtures/codex-app-server/thread-model.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const answer = { initialize: 1, 'skills/extraRoots/set': 2, 'thread/start': 3, 'turn/start': 4 };
  child.stdin.on('data', (chunk) => {
    for (const req of chunk
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))) {
      seen.push(req);
      if (req.id === undefined) continue;
      const recorded = lines.find((l) => l.id === answer[req.method]);
      child.stdout.write(`${JSON.stringify(recorded ? { ...recorded, id: req.id } : { id: req.id, result: { data: [], nextCursor: null } })}\n`);
      if (req.method === 'turn/start')
        setImmediate(() => {
          for (const l of lines.filter((x) => x.method)) child.stdout.write(`${JSON.stringify(l)}\n`);
        });
    }
  });
  return child;
}

test('#1315: a Codex persona on auto reports the model Codex opened its thread with, so no earlier backend’s model stays on its row', async () => {
  const seen = [];
  const reported = [];
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(seen) });
  await adapter.deliver(
    {},
    { kind: 'user', text: 'Reply with the single word ok.' },
    {
      persona: { handle: 'researcher', model: 'auto', effort: 'high', permissionMode: 'auto' },
      project: { folder: `${CODEX_ROOT}/project` },
      handles: ['researcher'],
      state: {},
      signal: new AbortController().signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
      text: () => {},
      activity: () => {},
      status: () => {},
      saveState: () => {},
      checkpoint: () => {},
      reported: (r) => reported.push(r),
      pathOf: () => null,
    },
  );
  assert.ok(!('model' in seen.find((x) => x.method === 'turn/start').params), 'auto names no model to Codex');
  assert.deepEqual(reported, [{ model: 'gpt-6.1-sol', effort: 'high' }]);
});
