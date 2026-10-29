// #485: an agent’s reply was posted with no text. A Claude Code turn of about 45 minutes ended with its report as the
// text after its last command, and Postbox posted the reply as an item with no text, so the report reached no one.
// Whatever the backend did, a turn that ends with no reply is never posted as an empty message: it ends as a failed
// reply that says so, with Retry; the item keeps the turn’s last raw lines for diagnosis; and the agent hears of it at
// its next turn.
//
// The stream is tests/fixtures/claude-code/background-moved.jsonl, a Bash call moved to the background at its timeout,
// cut from the HotpotQA UAT of 22 October 2026 (tests/agent-activity.test.mjs). As recorded, both its results carry the
// agent’s reply in `result.result` with no text event before them: the mapper now posts that text (the tests at the
// end). Whether Claude Code itself streamed text there isn’t known: the recording was cut. For the guard, the same
// stream with its results’ text blanked (SILENT) ends with steps and no text anywhere, which is what Postbox read in
// #485, whatever the cause.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { endedWithoutReply, noteAnswer } from '../server/empty-reply.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { readMessage } from '../server/read-message.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { setup as blocksSetup, settle as settleBlocks } from './blocks-fixture.mjs';

const LINES = readFileSync(new URL('fixtures/claude-code/background-moved.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean);
const SILENT = LINES.map((l) => {
  const e = JSON.parse(l);
  return e.type === 'result' ? JSON.stringify({ ...e, result: '' }) : l;
});

/** A claude that plays a recorded stream (by default this one, its results’ text blanked), then exits 0. */
const playing = (lines) => () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
  setImmediate(() => {
    for (const l of lines) child.stdout.write(`${l}\n`);
    child.stdout.end();
    setTimeout(() => child.emit('close', 0), 5);
  });
  return child;
};

function setup(lines = SILENT) {
  const store = new Store(null);
  const spawnImpl = playing(lines);
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-485/workspaces', spawnImpl }));
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters, corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp/pb-test-485' });
  const p = rt.createPersona({ handle: 'critic', backend: 'claude-code', folder: '/tmp/pb-test-485' });
  const t = rt.createThread({ projectId: 'p1', title: 'Q4 review', personaIds: [p.id] });
  return { store, rt, t, se: rt.sessionsIn(t.id)[0] };
}
const settle = async (rt) => {
  for (let i = 0; i < 400 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 5));
};

test('#485: a turn that ends with steps and no reply text ends as a failed reply that says so, with Retry', async () => {
  const { store, rt, t, se } = setup();
  rt.sendMessage(t.id, { text: '@critic check the Q4 claim' });
  await settle(rt);
  const replies = store.items(t.id).filter((i) => i.kind === 'agent' && i.sessionId === se.id);
  assert.ok(replies.length, 'the turn posted its steps');
  assert.ok(
    replies.every((i) => !i.text?.trim()),
    'no text reaches Postbox: the case #485 is about',
  );
  const last = replies.at(-1);
  assert.equal(last.status, 'failed', 'never left as a finished reply with no text');
  assert.equal(last.error, '@critic’s turn ended without a reply.');
  assert.ok(last.asked, 'Retry can send what it was asked again');
  assert.equal(store.state.sessions[se.id].needs?.kind, 'failed', 'the person is told, as for any failed reply');
});

test('#485: the empty reply keeps the turn’s raw ending, and the agent hears of it at its next turn', async () => {
  const { store, rt, t, se } = setup();
  rt.sendMessage(t.id, { text: '@critic check the Q4 claim' });
  await settle(rt);
  const last = store
    .items(t.id)
    .filter((i) => i.kind === 'agent' && i.sessionId === se.id)
    .at(-1);
  assert.equal(last.rawEnding?.backend, 'claude-code');
  assert.ok(last.rawEnding.lines.length > 0 && last.rawEnding.lines.length <= 12);
  // Each line’s shape only (integrator review of PR #536): its kinds and sizes, never its text, which can hold a file
  // or a secret a tool printed. The stream’s last event is its result, with its text blanked.
  const end = JSON.parse(last.rawEnding.lines.at(-1));
  assert.equal(end.type, 'result');
  assert.equal(end.result, 0, 'a string is kept as its length');
  const text = LINES.flatMap((l) =>
    (JSON.parse(l).message?.content ?? []).flatMap((b) => [b.text, typeof b.content === 'string' ? b.content : null]).filter((x) => x?.length > 30),
  );
  assert.ok(text.length, 'the stream has text to leave out');
  for (const x of text) assert.ok(!last.rawEnding.lines.some((l) => l.includes(x.slice(0, 30))), `kept: ${x.slice(0, 30)}`);
  assert.ok(
    last.rawEnding.lines.every((l) => l.length <= 1000),
    'each line is bounded',
  );
  assert.ok(
    (store.state.sessions[se.id].context ?? []).some((c) => /your last turn .* ended without a reply/i.test(c)),
    JSON.stringify(store.state.sessions[se.id].context),
  );
});

test('#485: only a turn that owes a reply is held to it; a block or a message to another agent is a reply', () => {
  const turn = (kind, said = '') => ({ id: 'tu_1', kind, said });
  const steps = [{ kind: 'agent', turnId: 'tu_1', text: '' }];
  // A message from the person or another agent, answered with steps only.
  assert.equal(endedWithoutReply(turn('user'), steps), true);
  assert.equal(endedWithoutReply(turn('agent'), steps), true);
  assert.equal(endedWithoutReply(turn('user', '\n\n'), steps), true, 'whitespace isn’t a reply');
  // Turns that may end quietly: an event (a block answered or dismissed, a review), a scheduled wake, a lint pass.
  for (const kind of ['event', 'wake', 'lint', 'app-check']) assert.equal(endedWithoutReply(turn(kind), steps), false, kind);
  // What else counts as its reply: a block, or a message it sent another agent.
  assert.equal(endedWithoutReply(turn('user'), [...steps, { kind: 'block', turnId: 'tu_1' }]), false);
  assert.equal(endedWithoutReply(turn('user'), [...steps, { kind: 'agent', fromTurnId: 'tu_1', text: '@beta over to you' }]), false);
});

test('#485: a reply that wrote its report and then failed still reaches the other agents, marked as failed', async () => {
  const { store, rt, adapter, t } = blocksSetup();
  const other = rt.createPersona({ handle: 'researcher' });
  rt.ensureSession(t.id, other.id);
  const researcher = rt.sessionsIn(t.id).find((x) => x.handle === 'researcher');
  adapter.next.push(async (c) => {
    c.activity({ id: 's1', label: 'Ran gh pr checks', state: 'done' });
    c.text('#451 is ready at 41f3a0f, and all 8 CI checks pass.');
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@critic watch the checks' });
  await settleBlocks(rt);
  const report = store.items(t.id).find((i) => i.kind === 'agent' && i.text?.includes('#451 is ready'));
  assert.equal(report.status, 'failed');
  // read_message by another agent: the text, and that the turn failed.
  const read = readMessage(rt, researcher, { id: report.id });
  assert.ok(read.ok, read.message);
  assert.match(read.message, /^@critic \(this reply failed: Claude Code exited with code 1\.\): #451 is ready at 41f3a0f/);
  // And the catch-up at that agent’s next turn.
  rt.sendMessage(t.id, { text: '@researcher what did critic find?' });
  await settleBlocks(rt);
  const sent = adapter.calls.at(-1).message;
  assert.ok(
    (sent.context ?? []).some((c) => c.includes('#451 is ready at 41f3a0f') && c.includes('this reply failed')),
    JSON.stringify(sent.context),
  );
});

test('#485: a turn that answers only with a Postbox call that acts, such as a reaction, isn’t marked failed', async () => {
  const { store, rt, adapter, t } = blocksSetup();
  const se = rt.sessionsIn(t.id)[0];
  const call = (name, args) =>
    handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rt.turns.get(se.id)?.token ?? null);
  adapter.next.push(async () => {
    const asked = store.items(t.id).find((i) => i.kind === 'user');
    const r = await call('react', { id: asked.id, emoji: '👍' });
    assert.equal(r.result.isError, false, JSON.stringify(r.result));
  });
  rt.sendMessage(t.id, { text: '@critic thanks, that’s all' });
  await settleBlocks(rt);
  assert.equal(store.state.sessions[se.id].needs, null, 'its reaction was its answer');
  // A turn that only read is still held to a reply.
  adapter.next.push(async () => {
    await call('read_conversation', {});
  });
  rt.sendMessage(t.id, { text: '@critic what did I just say?' });
  await settleBlocks(rt);
  assert.equal(store.state.sessions[se.id].needs?.kind, 'failed', 'reading isn’t answering');
});

/** The text the mapper writes for a recorded stream. */
const mappedText = (name) => {
  let text = '';
  const ctx = { text: (d) => (text += d), activity() {}, status() {}, job() {}, compaction() {}, denied() {}, saveState() {}, state: {} };
  const m = createStreamMapper(ctx, { now: () => 1000 });
  const lines = readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);
  for (const l of lines) {
    // As the adapter does (claude-code.mjs, readStream): an event the mapper can’t read is skipped, not the turn.
    try {
      m.push(JSON.parse(l));
    } catch {}
  }
  return text;
};
const squash = (s) => s.split(/\s+/).join(' ');

test('#485: a reply that reached the stream only in its result is posted from the result', () => {
  // background-moved.jsonl: both results carry the agent’s reply, with no text event before either (as recorded, cut).
  const text = squash(mappedText('background-moved'));
  assert.match(text, /You were right to doubt it, but the problem isn’t the one you named/);
  assert.match(text, /The background search for the dataset hit its time limit and was stopped/);
});

test('#485: a result whose text was streamed isn’t posted again, in every recorded stream', () => {
  const dir = new URL('fixtures/claude-code/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const name = f.replace(/\.jsonl$/, '');
    const text = squash(mappedText(name));
    const results = readFileSync(new URL(f, dir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'result' && !e.is_error && typeof e.result === 'string' && e.result.trim().length > 20);
    for (const r of results) {
      const head = squash(r.result.trim()).slice(0, 60);
      assert.ok(text.split(head).length - 1 <= 1, `${name}: “${head}” posted twice`);
    }
  }
});

test('#485: a slash command that prints nothing, such as /compact, isn’t an empty reply', async () => {
  // Integrator review of PR #536: tests/fixtures/claude-code/compact.jsonl, as recorded, ends with result '' and no text.
  const lines = readFileSync(new URL('fixtures/claude-code/compact.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);
  const { store, rt, t, se } = setup(lines);
  rt.runAgentCommand(t.id, { sessionId: se.id, text: '/compact' });
  await settle(rt);
  assert.equal(store.state.sessions[se.id].needs ?? null, null, 'no Retry, nothing for the person');
  assert.ok(!store.items(t.id).some((i) => i.kind === 'agent' && i.status === 'failed'));
});

test('#485: a result that repeats streamed Markdown as plain text isn’t posted again', async () => {
  // Integrator review of PR #536: “**the**” streamed, “the” in the result.
  const { replyText } = await import('../server/adapters/claude-reply.mjs');
  let out = '';
  const r = replyText({ text: (d) => (out += d) }, { wroteText: false });
  r.write('**The answer** is `42`, and _here_ is why it holds for every case.');
  r.fromResult({ type: 'result', result: 'The answer is 42, and here is why it holds for every case.' });
  assert.equal(out, '**The answer** is `42`, and _here_ is why it holds for every case.');
});

test('#485: a turn that only schedules or cancels a wake, or defines a term, still owes its reply', () => {
  const turn = { id: 'tu_1', kind: 'user', said: '' };
  for (const name of ['schedule_wake', 'cancel_wake', 'define_term']) noteAnswer(turn, name, { ok: true });
  assert.equal(endedWithoutReply(turn, []), true);
});
