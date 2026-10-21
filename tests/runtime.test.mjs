import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Runtime, HOP_LIMIT } from '../server/runtime.mjs';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { handleMcp } from '../server/mcp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter whose replies the test scripts per call. */
class ScriptedAdapter {
  name = 'mock';
  constructor() { this.calls = []; this.next = []; }
  async deliver(session, message, ctx) {
    this.calls.push({ handle: session.handle, message });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message, session);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha', tools: ['corpus.search'] });
  const b = rt.createPersona({ handle: 'beta' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { store, rt, adapter, t, a, b };
}
const settle = async (rt) => { for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5); await sleep(5); };

test('a message goes to the thread’s agent and its reply streams into an item', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => { c.text('Hello '); c.text('there.'); });
  rt.sendMessage(t.id, { text: 'hi' });
  await settle(rt);
  const items = store.items(t.id);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'agent']);
  assert.equal(items[1].text, 'Hello there.');
  assert.equal(items[1].status, 'done');
});

test('@-mentioning an agent that isn’t in the thread brings it in and turns the thread into a room', async () => {
  const { rt, store, t } = setup();
  rt.sendMessage(t.id, { text: '@beta take a look' });
  await settle(rt);
  assert.equal(store.state.threads[t.id].kind, 'room');
  assert.ok(store.items(t.id).some((i) => i.kind === 'system' && i.variant === 'wake' && i.to === 'beta'));
});

test('a message sent mid-reply is queued, then delivered when the agent finishes', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => { c.text('working'); await sleep(40); });
  rt.sendMessage(t.id, { text: 'first' });
  const r = rt.sendMessage(t.id, { text: 'second' });
  assert.ok(r.queued);
  assert.equal(store.state.threads[t.id].queue.length, 1);
  await settle(rt);
  assert.equal(store.state.threads[t.id].queue.length, 0);
  assert.deepEqual(store.items(t.id).filter((i) => i.kind === 'user').map((i) => i.text), ['first', 'second']);
});

test('Stop ends the turn cleanly and marks the reply stopped', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => { c.text('partial'); await new Promise((res, rej) => c.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))); });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(10);
  const se = rt.sessionsIn(t.id)[0];
  assert.equal(rt.stop(se.id), true);
  await settle(rt);
  assert.equal(store.items(t.id).find((i) => i.kind === 'agent').status, 'stopped');
  assert.equal(store.state.sessions[se.id].state, 'idle');
});

test('a failing turn shows the error, asks for you, and can be retried', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async () => { throw Object.assign(new Error('boom'), { userMessage: 'The model didn’t respond.' }); });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const failed = store.items(t.id).find((i) => i.status === 'failed');
  assert.equal(failed.error, 'The model didn’t respond.');
  const se = rt.sessionsIn(t.id)[0];
  assert.equal(store.state.sessions[se.id].needs.kind, 'failed');
  rt.retry(t.id, failed.id);
  await settle(rt);
  assert.equal(store.items(t.id).at(-1).status, 'done');
  assert.equal(store.state.sessions[se.id].needs, null);
});

test('an open choice makes the agent need you; answering it sends one event and a line in your voice', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => { c.tools.show_block({ block: { id: 'q', type: 'choice', version: 1, fallback: 'Pick', title: 'Pick one', options: [{ id: 'a', label: 'A' }] } }); });
  rt.sendMessage(t.id, { text: 'ask me' });
  await settle(rt);
  const se = rt.sessionsIn(t.id)[0];
  assert.equal(store.state.sessions[se.id].state, 'needs');
  const block = store.items(t.id).find((i) => i.kind === 'block');
  rt.act(t.id, block.id, 'choose', { selected: ['a'] });
  await settle(rt);
  assert.equal(store.item(t.id, block.id).answered, true);
  assert.ok(store.items(t.id).some((i) => i.kind === 'voice' && i.text === 'Chose: A'));
  assert.deepEqual(adapter.calls.at(-1).message, { kind: 'event', event: { blockId: 'q', action: 'choose', values: { selected: ['a'] } } });
  assert.throws(() => rt.act(t.id, block.id, 'choose', { selected: ['a'] }), /already answered/);
});

test('an invalid block is stored with its fallback, never rendered as given', async () => {
  const { rt, store, t, adapter } = setup();
  let result;
  adapter.next.push(async (c) => { result = c.tools.show_block({ block: { id: 'x', type: 'timeline', version: 1, fallback: 'Plain version' } }); });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const b = store.items(t.id).find((i) => i.kind === 'block');
  assert.equal(b.valid, false);
  assert.equal(b.fallback, 'Plain version');
  assert.equal(result.ok, false);
});

test(`after ${HOP_LIMIT} agent wakes in a row, the next one waits for your confirm`, async () => {
  const { rt, store, t, b } = setup();
  rt.ensureSession(t.id, b.id);
  const alpha = rt.sessionsIn(t.id).find((x) => x.handle === 'alpha');
  for (let i = 0; i < HOP_LIMIT; i++) assert.equal(rt.agentWake(alpha.id, 'beta', 'check').ok, true);
  await settle(rt);
  const r = rt.agentWake(alpha.id, 'beta', 'check again');
  assert.equal(r.waiting, true);
  const hop = store.items(t.id).find((i) => i.kind === 'hop');
  assert.equal(hop.status, 'open');
  assert.equal(rt.agentWake(alpha.id, 'beta', 'and again').waiting, true);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'hop').length, 1, 'only one request waits at a time');
  rt.act(t.id, hop.id, 'confirm');
  await settle(rt);
  assert.equal(store.item(t.id, hop.id).status, 'allowed');
});

test('a message from you resets the wake count', async () => {
  const { rt, store, t, b } = setup();
  rt.ensureSession(t.id, b.id);
  const alpha = rt.sessionsIn(t.id).find((x) => x.handle === 'alpha');
  rt.agentWake(alpha.id, 'beta', 'one');
  rt.agentWake(alpha.id, 'beta', 'two');
  await settle(rt);
  rt.sendMessage(t.id, { text: '@alpha carry on' });
  assert.equal(store.state.threads[t.id].hops, 0);
});

test('agents wake each other in a side thread, and your thread shows one link to it', async () => {
  const { rt, store, t, b, adapter } = setup();
  const alpha = rt.sessionsIn(t.id)[0];
  adapter.next.push(async (c) => c.text('Editions are fine.'));
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await settle(rt);
  const side = Object.values(store.state.threads).find((x) => x.kind === 'side');
  assert.ok(side);
  assert.equal(side.parentId, t.id);
  const link = store.items(t.id).find((i) => i.kind === 'sidelink');
  assert.ok(link.count >= 1);
  // Beta’s reply goes back to alpha as a message from @beta.
  assert.ok(adapter.calls.some((c) => c.handle === 'alpha' && c.message.kind === 'agent' && c.message.from === '@beta'));
  assert.equal(store.state.sessions[alpha.id].agentMessages[0].other, 'beta');
});

test('deleting a session can be undone within the window', async () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const { until } = rt.deleteSession(se.id);
  assert.ok(until > Date.now());
  assert.ok(store.state.sessions[se.id].deleting);
  rt.undoDelete(se.id);
  assert.equal(store.state.sessions[se.id].deleting, null);
  rt.deleteSession(se.id);
  rt.purgeSession(se.id);
  assert.equal(store.state.sessions[se.id], undefined);
  assert.equal(store.state.threads[t.id], undefined, 'its own thread goes with it');
});

test('deleting an agent in a room keeps its messages, marked deleted', async () => {
  const { rt, store, t, b } = setup();
  rt.ensureSession(t.id, b.id);
  rt.sendMessage(t.id, { text: '@beta hi' });
  await settle(rt);
  const beta = rt.sessionsIn(t.id).find((x) => x.handle === 'beta');
  rt.deleteSession(beta.id);
  rt.purgeSession(beta.id);
  assert.ok(store.state.threads[t.id]);
  assert.ok(store.items(t.id).filter((i) => i.sessionId === beta.id).every((i) => i.deletedAgent));
  assert.ok(store.items(t.id).some((i) => i.kind === 'system' && i.variant === 'left'));
});

test('apps can query only tools both they and their agent were granted', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => c.tools.show_app({ id: 'ap', title: 'App', code: '<p>hi</p>', permissions: ['corpus.search', 'shell'] }));
  rt.sendMessage(t.id, { text: 'make an app' });
  await settle(rt);
  assert.deepEqual(rt.appQuery('ap', 'corpus.search', { query: 'x' }), []);
  assert.throws(() => rt.appQuery('ap', 'shell', {}), /can’t use “shell”/);
  assert.throws(() => rt.appQuery('ap', 'corpus.read', {}), /can’t use “corpus.read”/);
});

test('a failed pre-display check goes back to the agent once; a second failure shows the app with a note', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.tools.show_app({ id: 'ap', title: 'App', code: '<p>hi</p>' }));
  rt.sendMessage(t.id, { text: 'make an app' });
  await settle(rt);
  adapter.next.push(async (c) => c.tools.update_app({ id: 'ap', code: '<p>fixed?</p>' }));
  assert.equal(rt.appCheck('ap', { version: 1, problems: [{ code: 'overflow-375', message: 'Too wide.' }] }).status, 'fixing');
  await settle(rt);
  assert.equal(adapter.calls.at(-1).message.kind, 'app-check');
  assert.equal(store.state.apps.ap.current, 2);
  assert.equal(rt.appCheck('ap', { version: 2, problems: [{ code: 'overflow-375', message: 'Still too wide.' }] }).status, 'note');
});

test('MCP: initialize, list tools, and a tool call that returns at once', async () => {
  const { rt, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const init = handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'postbox');
  assert.equal(handleMcp(rt, se.id, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const tools = handleMcp(rt, se.id, { jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((x) => x.name);
  assert.ok(tools.includes('show_block') && tools.includes('wake_agent'));
  const r = handleMcp(rt, se.id, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'show_block', arguments: { block: { id: 'c', type: 'confirm', version: 1, fallback: 'x', statement: 'Do it?', confirmLabel: 'Do it' } } } });
  assert.equal(r.result.isError, false);
  const bad = handleMcp(rt, 'nope', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'show_block', arguments: {} } });
  assert.match(bad.error.message, /Unknown Postbox session/);
  assert.equal(handleMcp(rt, se.id, { jsonrpc: '2.0', id: 5, method: 'nope' }).error.code, -32601);
});
