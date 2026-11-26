// #425: /compact on a Codex agent runs Codex’s own compaction (app-server thread/compact/start), not a prompt, and the
// room shows the compaction. Replayed from a recorded Codex 0.167.0 session (tests/fixtures/codex-app-server/
// compact.jsonl: one turn, then thread/compact/start on its thread; account, rate-limit and MCP lines left out, ids
// and paths replaced).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';

const RECORDED = readFileSync(new URL('fixtures/codex-app-server/compact.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

/** An app-server that answers as the recording did: the thread it opened, and the compaction turn after its answer. */
function recordedServer(/** @type {any[]} */ seen) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => child.emit('close', 0);
  const answerAt = RECORDED.findIndex((l) => l.id === 4); // thread/compact/start’s answer
  const answer = { initialize: 1, 'thread/resume': 2, 'thread/start': 2, 'thread/compact/start': 4 };
  const write = (/** @type {any} */ m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  child.stdin.on('data', (chunk) => {
    for (const req of chunk
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))) {
      seen.push(req);
      if (req.id === undefined) continue;
      const recorded = RECORDED.find((l) => l.id === answer[req.method]);
      write(recorded ? { ...recorded, id: req.id } : { id: req.id, result: { data: [], nextCursor: null } });
      if (req.method === 'thread/compact/start') setImmediate(() => RECORDED.slice(answerAt + 1).forEach(write));
    }
  });
  return child;
}

/** A turn’s context, with what the harness events reached. */
function context(state = { codexThreadId: 'thr-1' }) {
  const seen = { compactions: /** @type {any[]} */ ([]), steps: /** @type {string[]} */ ([]), text: '' };
  const ctx = {
    persona: { handle: 'gpt', model: 'auto', effort: 'medium', permissionMode: 'auto' },
    project: { folder: `${CODEX_ROOT}/project` },
    handles: ['gpt'],
    state,
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: (/** @type {string} */ t) => (seen.text += t),
    activity: () => {},
    status: (/** @type {any} */ s) => s?.currentStep && seen.steps.push(s.currentStep),
    compaction: (/** @type {any} */ c) => seen.compactions.push(c),
    saveState: () => {},
    checkpoint: () => {},
    reported: () => {},
    pathOf: () => null,
  };
  return { ctx, seen };
}

test('#425 /compact on a Codex agent runs Codex’s compaction of its thread, and the room shows it, with no prompt sent', async () => {
  const requests = /** @type {any[]} */ ([]);
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(requests) });
  const { ctx, seen } = context();
  await adapter.deliver({}, { kind: 'user', text: '/compact', slash: true }, ctx);
  const methods = requests.map((r) => r.method);
  assert.ok(methods.includes('thread/compact/start'), methods.join(', '));
  assert.ok(!methods.includes('turn/start'), 'no prompt goes to the model');
  assert.deepEqual(requests.find((r) => r.method === 'thread/compact/start').params, { threadId: 'thr-1' });
  assert.equal(seen.compactions.length, 1, 'the compaction reaches the room');
  assert.equal(seen.compactions[0].kept, undefined, 'Codex counts nothing, so nothing is made up');
  assert.equal(seen.compactions[0].total, undefined);
  assert.match(seen.compactions[0].summary, /Codex summarized/);
  assert.equal(seen.text, '', 'the agent says nothing of its own');
});

test('#425 /compact with words after it is still Codex’s compaction, and a person’s message that starts with it is a prompt', async () => {
  const requests = /** @type {any[]} */ ([]);
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(requests) });
  await adapter.deliver({}, { kind: 'user', text: '/compact keep the plan', slash: true }, context().ctx);
  assert.ok(requests.some((r) => r.method === 'thread/compact/start'));
  assert.ok(!requests.some((r) => r.method === 'turn/start'));
  // A person’s message that starts with the word isn’t the command: only the composer’s command is.
  const typed = /** @type {any[]} */ ([]);
  await new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer(typed) }).deliver(
    {},
    { kind: 'user', text: '/compact the proof, please' },
    context().ctx,
  );
  assert.ok(
    typed.some((r) => r.method === 'turn/start'),
    'it goes to the model as written',
  );
  assert.ok(!typed.some((r) => r.method === 'thread/compact/start'));
});

test('#425 /compact on a Codex agent with no conversation yet says there’s nothing to compact, and starts nothing', async () => {
  const requests = /** @type {any[]} */ ([]);
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(requests) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: '/compact', slash: true }, context({}).ctx), /nothing to compact yet/);
  assert.ok(!requests.some((r) => ['thread/start', 'thread/compact/start', 'turn/start'].includes(r.method)));
});
