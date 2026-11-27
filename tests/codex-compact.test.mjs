// #425: /compact on a Codex agent runs Codex’s own compaction (app-server thread/compact/start), not a prompt, and the
// room shows the compaction. Replayed from a recorded Codex 0.167.0 session (tests/fixtures/codex-app-server/
// compact.jsonl: one turn, then thread/compact/start on its thread; account, rate-limit and MCP lines left out, ids
// and paths replaced). The thread going on after it is replayed from two more (compact-continue.jsonl: a turn and
// thread/compact/start; compact-resume.jsonl: a new process that resumes that thread and asks for a word from the
// first turn; tests/fixtures/codex-app-server/README.md).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const RECORDED = readFileSync(new URL('fixtures/codex-app-server/compact.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

/**
 * An app-server that answers as the recording did: the thread it opened, and the compaction turn after its answer.
 * `compact`, when given, answers thread/compact/start instead, for a compaction that fails.
 * @param {any[]} seen @param {{ compact?: (req: any, write: (m: any) => void) => void }} [opts]
 */
function recordedServer(seen, { compact } = {}) {
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
      if (compact && req.method === 'thread/compact/start') {
        compact(req, write);
        continue;
      }
      const recorded = RECORDED.find((l) => l.id === answer[req.method]);
      const prompt = req.method === 'turn/start' ? { id: req.id, result: { turn: { id: 'turn-prompt', status: 'inProgress' } } } : null;
      write(recorded ? { ...recorded, id: req.id } : (prompt ?? { id: req.id, result: { data: [], nextCursor: null } }));
      if (req.method === 'thread/compact/start') setImmediate(() => RECORDED.slice(answerAt + 1).forEach(write));
      // A prompt turn, as before #425: it ends at once, so a regression fails on what was sent, not on a timeout.
      if (req.method === 'turn/start') setImmediate(() => write({ method: 'turn/completed', params: { turn: { id: 'turn-prompt', status: 'completed' } } }));
    }
  });
  return child;
}

/**
 * A recording’s answers by request id: each answer, then the notifications it had before its next answer.
 * @param {string} name @returns {Map<number, any[]>}
 */
function answersOf(name) {
  const after = new Map();
  let answered = /** @type {any[]} */ ([]);
  for (const l of readFileSync(new URL(`fixtures/codex-app-server/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')) {
    const line = JSON.parse(l);
    if (line.id === undefined) answered.push(line);
    else after.set(line.id, (answered = [line]));
  }
  return after;
}

/**
 * Spawns app-servers for three turns, one process each, as Postbox runs them: the first message, /compact, and the
 * next message. The first two answer from compact-continue.jsonl (thread/start and its turn, then the compaction); the
 * third from compact-resume.jsonl, a new process that resumed the compacted thread and ran one turn on it. Nothing
 * recorded the /compact turn’s own resume, so it gets the thread/resume answer compact-resume.jsonl recorded for the
 * same thread, without the notifications after it: the turn reads only the thread’s id and model from it.
 * The recording’s driver asked without excludeTurns, so its answer holds the history Postbox’s request leaves out.
 * @param {any[]} seen what Postbox sent @param {any[]} answered what each request got, beside it
 */
function compactedServers(seen, answered) {
  const [first, resumed] = [answersOf('compact-continue.jsonl'), answersOf('compact-resume.jsonl')];
  const plays = [
    { initialize: first.get(1), 'thread/start': first.get(2), 'turn/start': first.get(3) },
    { initialize: first.get(1), 'thread/resume': resumed.get(2)?.slice(0, 1), 'thread/compact/start': first.get(4) },
    { initialize: resumed.get(1), 'thread/resume': resumed.get(2), 'turn/start': resumed.get(3) },
  ];
  return () => {
    const play = /** @type {Record<string, any[] | undefined>} */ (plays.shift() ?? {});
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => child.emit('close', 0);
    const write = (/** @type {any} */ m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    child.stdin.on('data', (chunk) => {
      for (const req of chunk
        .toString()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))) {
        seen.push(req);
        if (req.id === undefined) continue;
        const [answer = { result: { data: [], nextCursor: null } }, ...notes] = play[req.method] ?? [];
        answered.push([req.method, answer]);
        write({ ...answer, id: req.id });
        setImmediate(() => notes.forEach(write));
      }
    });
    return child;
  };
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
  assert.ok(seen.steps.includes('Summarizing the conversation'), `its step while it runs: ${seen.steps.join(', ')}`);
  assert.equal(seen.text, '', 'the agent says nothing of its own');
});

test('#425 after a Codex /compact, the next message resumes the compacted thread in a new app-server, and its reply reaches the room', async () => {
  const [requests, answered] = [/** @type {any[]} */ ([]), /** @type {any[]} */ ([])];
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: compactedServers(requests, answered) });
  const state = {};
  const first = context(state);
  await adapter.deliver({}, { kind: 'user', text: 'Remember the word heron. Reply with just OK.' }, first.ctx);
  const compact = context(state);
  await adapter.deliver({}, { kind: 'user', text: '/compact', slash: true }, compact.ctx);
  const [sentBefore, answeredBefore] = [requests.length, answered.length];
  const next = context(state);
  await adapter.deliver({}, { kind: 'user', text: 'What word did I ask you to remember? Reply with just the word.' }, next.ctx);
  const sent = requests.slice(sentBefore);
  assert.deepEqual(
    sent.filter((r) => r.method.startsWith('thread/') || r.method === 'turn/start').map((r) => [r.method, r.params.threadId]),
    [
      ['thread/resume', 'thr-1'],
      ['turn/start', 'thr-1'],
    ],
    'the compacted thread, resumed, and an ordinary turn on it',
  );
  const [, resume] = answered.slice(answeredBefore).find(([m]) => m === 'thread/resume');
  assert.equal(resume.result.thread.id, 'thr-1', 'Codex’s recorded resume of it');
  assert.equal(resume.result.thread.turns.length, 3, 'its history: the first turn, the compaction and the turn after it');
  assert.match(sent.find((r) => r.method === 'turn/start').params.input[0].text, /What word did I ask you to remember\?/);
  assert.equal(next.seen.text, 'heron', 'the reply after the compaction reaches the room');
  assert.deepEqual(
    [first, compact, next].map(({ seen }) => [seen.text, seen.compactions.length]),
    [
      ['OK', 0],
      ['', 1],
      ['heron', 0],
    ],
    'one compaction, between the two replies',
  );
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

test('#425 a /compact that still reaches a Codex turn with no conversation fails with the reason, and sends no compaction', async () => {
  const requests = /** @type {any[]} */ ([]);
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(requests) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: '/compact', slash: true }, context({}).ctx), /nothing to compact yet/);
  assert.ok(!requests.some((r) => ['thread/start', 'thread/compact/start', 'turn/start'].includes(r.method)), 'no thread opened and no prompt sent');
});

// The failures’ shapes are Codex 0.167.0’s (`codex app-server generate-json-schema`): a JSON-RPC error answer; and an
// ErrorNotification { error: TurnError, willRetry, threadId, turnId } followed by a TurnCompletedNotification whose
// turn has status "failed".
test('#425 a /compact Codex refuses fails with Codex’s reason, and shows no compaction', async () => {
  const requests = /** @type {any[]} */ ([]);
  const refuse = (/** @type {any} */ req, /** @type {any} */ write) => write({ id: req.id, error: { code: -32600, message: 'thread thr-1 is busy' } });
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(requests, { compact: refuse }) });
  const { ctx, seen } = context();
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: '/compact', slash: true }, ctx), /thread thr-1 is busy/);
  assert.equal(seen.compactions.length, 0, 'nothing was compacted, so none is shown');
  assert.ok(!requests.some((r) => r.method === 'turn/start'), 'no prompt goes to the model instead');
});

test('#425 a Codex compaction turn that fails before its item completes shows no compaction', async () => {
  const requests = /** @type {any[]} */ ([]);
  const failTurn = (/** @type {any} */ req, /** @type {any} */ write) => {
    write({ id: req.id, result: {} });
    const turn = { id: 'id-3', status: 'inProgress', error: null };
    setImmediate(() => {
      write({ method: 'turn/started', params: { threadId: 'thr-1', turn } });
      write({ method: 'item/started', params: { item: { type: 'contextCompaction', id: 'id-4' }, threadId: 'thr-1', turnId: 'id-3' } });
      const error = { message: 'the summary request was rejected' };
      write({ method: 'error', params: { error, willRetry: false, threadId: 'thr-1', turnId: 'id-3' } });
      write({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { ...turn, status: 'failed', error } } });
    });
  };
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer(requests, { compact: failTurn }) });
  const { ctx, seen } = context();
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: '/compact', slash: true }, ctx), /the summary request was rejected/);
  assert.equal(seen.compactions.length, 0, 'a compaction shows only once Codex completes its item');
  assert.ok(seen.steps.includes('Summarizing the conversation'), 'its step showed while it ran');
});

test('#425 /compact for a Codex agent with no conversation yet is refused before anything is posted or started', () => {
  const store = new Store(null);
  const codex = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => recordedServer([]) });
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(codex),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: CODEX_ROOT });
  const p = rt.createPersona({ handle: 'gpt', backend: 'codex' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  const before = store.items(t.id).length;
  assert.throws(
    () => rt.runAgentCommand(t.id, { sessionId: se.id, text: '/compact' }),
    (e) => e.status === 422 && /nothing to compact yet/.test(e.message),
  );
  assert.equal(store.items(t.id).length, before, 'nothing posted');
  assert.equal(rt.turns.size, 0, 'no turn');
  // With a conversation, or for any other command, nothing is refused.
  assert.equal(codex.refuses('/compact', { codexThreadId: 'thr-1' }, 'gpt'), null);
  assert.equal(codex.refuses('/review', {}, 'gpt'), null);
  // A topic thread’s first turn compacts the thread it forks from, and a longer name isn’t this command.
  assert.equal(codex.refuses('/compact', { fork: { threadId: 'thr-1' } }, 'gpt'), null);
  assert.equal(codex.refuses('/compactor', {}, 'gpt'), null);
});

test('#874 a command to an agent whose backend isn’t registered is still posted, and its turn fails with the reason', async () => {
  const f = setup();
  f.store.emit('persona', { ...f.rt.persona(f.b.id), backend: 'claude-code' });
  const { item } = f.rt.runAgentCommand(f.t.id, { sessionId: f.beta.id, text: '/review' });
  assert.equal(f.store.item(f.t.id, item.id)?.text, '/review', 'posted, not a 500');
  await settle(f.rt);
  assert.ok(f.store.items(f.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'));
});
