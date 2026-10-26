// The fake daemon (tests/fake-daemon.mjs) against the protocol: what it answers, replays and queues, so the tests
// that use it stand on what the real daemon does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encode, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN, FIXTURE_PROMPT, fixtureLines, readMessages } from './fake-daemon.mjs';
import { start } from './remote-protocol-cases.mjs';

// ── The fake daemon ─────────────────────────────────────────────────────────────────

/** Postbox’s side of a connection to the fake. @param {{ stdin: any, stdout: any }} conn */
const client = ({ stdin, stdout }) => {
  const r = readMessages(stdout);
  return { ...r, send: (type, body = {}) => stdin.write(encode(message('postbox-to-daemon', type, body))) };
};
const FIXTURE = readFileSync(new URL('./fixtures/claude-code/permission-allow.jsonl', import.meta.url), 'utf8');
const FIXTURE_BYTES = Buffer.from(FIXTURE, 'utf8');

test('the fake daemon refuses a wrong token, then welcomes the right one with the harnesses it has', async () => {
  const d = createFakeDaemon({ harnesses: ['claude-code'] });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: 'b'.repeat(40) });
  assert.equal((await c.next('error')).code, 'bad-token');
  c.send('stop', { turn: 't1' });
  assert.equal((await c.next('error')).code, 'not-ready', 'nothing but hello before a good hello');
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  const w = await c.next('welcome');
  assert.equal(w.home, '/home/user');
  assert.deepEqual(
    w.harnesses.map((h) => [h.name, h.path !== null]),
    [
      ['claude-code', true],
      ['kiro-cli', false],
      ['codex', false],
    ],
  );
});

test('a turn on the fake replays the recorded stream with the byte offsets out.jsonl would have, then ends', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await c.next('welcome');
  c.send('start', start);
  c.send('read', { turn: 't1', from: 0 });
  assert.equal((await c.next('started')).turn, 't1');
  const ended = await c.next('ended');
  const got = c.messages.filter((m) => m.type === 'line');
  assert.equal(got.length, fixtureLines().length);
  assert.equal(got.map((l) => `${l.text}\n`).join(''), FIXTURE, 'the lines are the fixture, byte for byte');
  for (const l of got) assert.equal(FIXTURE_BYTES.subarray(l.offset, l.next - 1).toString('utf8'), l.text);
  assert.deepEqual(ended.exit, { code: 0, signal: null, at: 1_760_000_000_000 });
  assert.equal(ended.size, FIXTURE_BYTES.length);
  assert.equal(got.at(-1).next, ended.size);
  assert.match(JSON.parse(got.at(-2).text).result, /^I ran `echo hello > hello\.txt`/, 'the result is the recorded one');
});

test('a read from a line’s offset replays from there, and an offset inside a line is refused', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  await c.next('started');
  const third = d.turns.get('t1').out[2];
  c.send('read', { turn: 't1', from: third.offset });
  await c.next('ended');
  const got = c.messages.filter((m) => m.type === 'line');
  assert.equal(got[0].offset, third.offset);
  assert.equal(got.length, fixtureLines().length - 2);
  c.send('read', { turn: 't1', from: third.offset + 1 });
  const e = await c.next('error');
  assert.deepEqual([e.code, e.re, e.turn], ['bad-offset', 'read', 't1']);
});

test('a running turn on the fake follows appended lines, records the ack, and a stop ends it with SIGINT', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: fixtureLines().slice(0, 2) });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  c.send('read', { turn: 't1', from: 0 });
  await c.next('line');
  const second = await c.next('line');
  d.append('t1', '{"type":"system","subtype":"status"}');
  const third = await c.next('line');
  assert.equal(third.offset, second.next);
  c.send('ack', { turn: 't1', upTo: third.next });
  c.send('stop', { turn: 't1' });
  const ended = await c.next('ended');
  assert.deepEqual(d.stops, ['t1']);
  assert.equal(d.turns.get('t1').acked, third.next);
  assert.deepEqual([ended.exit.code, ended.exit.signal, ended.size], [null, 'SIGINT', third.next]);
});

test('tools and prompts queued while Postbox is away arrive after it reconnects, and leave the queue when answered', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const first = client(d);
  first.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  first.send('start', start);
  await first.next('started');
  d.drop();
  await first.ended;
  const tool = d.tool('t1', 'show_block', { block: { id: 'pick', type: 'choice' } });
  const prompt = d.prompt('t1');
  const late = d.prompt('t1', { tool_name: 'Write', input: { file_path: '/home/user/x' } });
  d.expire('t1', late);
  const again = client(d.connect());
  again.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  const w = await again.next('welcome');
  assert.deepEqual(w.turns, [{ turn: 't1', harness: 'claude-code', state: 'running', size: FIXTURE_BYTES.length, exit: null }]);
  assert.equal((await again.next('tool')).id, tool);
  const p = await again.next('prompt');
  assert.deepEqual([p.id, p.request], [prompt, FIXTURE_PROMPT]);
  assert.equal(again.messages.filter((m) => m.type === 'prompt').length, 1, 'an expired prompt isn’t resent');
  again.send('reply', { turn: 't1', id: tool, ok: true, text: 'Shown.' });
  again.send('answer', { turn: 't1', prompt, result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  again.send('answer', { turn: 't1', prompt, result: { behavior: 'deny', message: 'Too late.' } });
  assert.equal((await again.next('error')).code, 'no-prompt', 'a prompt is answered once');
  assert.deepEqual(d.queued, { tools: [], prompts: [] });
});

test('a prompt expiring while Postbox is connected is sent as prompt-expired', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await c.next('welcome');
  const id = d.prompt('t1');
  await c.next('prompt');
  d.expire('t1', id);
  assert.deepEqual(await c.next('prompt-expired'), { type: 'prompt-expired', id, turn: 't1', at: 1_760_000_000_000 });
});

test('a held stdin takes writes, says where in.jsonl got to, and serves in.jsonl to a read with log: in', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', { ...start, harness: 'codex', stdin: 'held', files: [] });
  const req = '{"id":1,"method":"initialize","params":{}}';
  c.send('write', { turn: 't1', line: req });
  assert.deepEqual(await c.next('written'), { type: 'written', turn: 't1', upTo: req.length + 1 });
  c.send('read', { turn: 't1', from: 0, log: 'in' });
  const l = await c.next('line');
  assert.deepEqual([l.log, l.text], ['in', req]);
  c.send('start', { ...start, turn: 't2' });
  c.send('write', { turn: 't2', line: req });
  assert.equal((await c.next('error')).code, 'not-held', 'a file stdin takes no writes');
});

test('a second Postbox is refused as busy unless it takes over, and the first is told', async () => {
  const d = createFakeDaemon();
  const first = client(d);
  first.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await first.next('welcome');
  const second = client(d.connect());
  second.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  assert.equal((await second.next('error')).code, 'busy');
  second.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN, takeover: true });
  await second.next('welcome');
  assert.equal((await first.next('error')).code, 'taken-over');
  await first.ended;
});

test('the fake refuses a malformed line with bad-message and goes on serving the connection', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  d.stdin.write('{"type":"start","turn":"t1","folder":"relative"}\n');
  const e = await c.next('error');
  assert.equal(e.code, 'bad-message');
  assert.match(e.message, /start needs “harness”|start\.folder/);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await c.next('welcome');
  assert.equal(d.errors.length, 1);
});

test('a turn already on the host shows in welcome, and a restarted Postbox replays it from offset 0', async () => {
  const d = createFakeDaemon();
  d.addTurn('old', { exit: { code: 0, signal: null } });
  d.addTurn('lost', { harness: 'kiro-cli', stdin: 'none', lines: [], interrupted: true });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  const w = await c.next('welcome');
  assert.deepEqual(
    w.turns.map((t) => [t.turn, t.state]),
    [
      ['old', 'ended'],
      ['lost', 'interrupted'],
    ],
  );
  c.send('read', { turn: 'lost', from: 0 });
  assert.deepEqual(await c.next('ended'), { type: 'ended', turn: 'lost', exit: null, size: 0 });
  c.send('read', { turn: 'old', from: 0 });
  assert.equal((await c.next('ended')).turn, 'old');
  assert.equal(c.messages.filter((m) => m.type === 'line' && m.turn === 'old').length, fixtureLines().length);
});

test('remove ends every turn, answers removed and closes the connection', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  await c.next('started');
  c.send('remove');
  await c.next('removed');
  await c.ended;
  assert.equal(d.turns.size, 0);
});

/** Two running turns on the fake whose shims both queued prompt 1 and tool call 1. */
async function twoTurnsUsingId1() {
  const d = createFakeDaemon({ autoEnd: false });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  c.send('start', { ...start, turn: 't2' });
  await c.next('started');
  await c.next('started');
  const write = { tool_name: 'Write', input: { file_path: '/home/user/x' } };
  assert.equal(d.prompt('t1', FIXTURE_PROMPT, '1'), '1');
  assert.equal(d.prompt('t2', write, '1'), '1');
  d.tool('t1', 'corpus_search', { query: 'one' }, '1');
  d.tool('t2', 'corpus_search', { query: 'two' }, '1');
  return { d, c };
}

test('two turns whose shims both use ID 1 each get only their own answer and reply', async () => {
  const { d, c } = await twoTurnsUsingId1();
  const prompts = [await c.next('prompt'), await c.next('prompt')];
  assert.deepEqual(
    prompts.map((p) => [p.turn, p.id, p.request.tool_name]),
    [
      ['t1', '1', FIXTURE_PROMPT.tool_name],
      ['t2', '1', 'Write'],
    ],
  );
  c.send('answer', { turn: 't2', prompt: '1', result: { behavior: 'deny', message: 'Not that file.' } });
  c.send('reply', { turn: 't1', id: '1', ok: true, text: 'Found one.' });
  c.send('answer', { turn: 't3', prompt: '1', result: { behavior: 'deny', message: 'No such turn.' } });
  const e = await c.next('error');
  assert.deepEqual([e.code, e.turn], ['no-prompt', 't3'], 'an answer for another turn’s ID 1 finds nothing');
  assert.deepEqual(d.queued, { tools: [{ turn: 't2', id: '1' }], prompts: [{ turn: 't1', id: '1' }] });
  assert.deepEqual(
    d.answers.map((a) => [a.turn, a.id, a.result.behavior]),
    [['t2', '1', 'deny']],
  );
  assert.deepEqual(
    d.replies.map((r) => [r.turn, r.id, r.text]),
    [['t1', '1', 'Found one.']],
  );
  c.send('answer', { turn: 't1', prompt: '1', result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  c.send('reply', { turn: 't2', id: '1', ok: true, text: 'Found two.' });
  c.send('answer', { turn: 't1', prompt: '1', result: { behavior: 'deny', message: 'Again.' } });
  assert.equal((await c.next('error')).code, 'no-prompt', 'each turn’s prompt is answered once');
  assert.deepEqual(
    d.answers.map((a) => [a.turn, a.result.behavior]),
    [
      ['t2', 'deny'],
      ['t1', 'allow'],
    ],
  );
  assert.deepEqual(
    d.replies.map((r) => [r.turn, r.text]),
    [
      ['t1', 'Found one.'],
      ['t2', 'Found two.'],
    ],
  );
  assert.deepEqual(d.queued, { tools: [], prompts: [] });
});
