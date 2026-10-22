import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { HOP_LIMIT, Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter whose replies the test scripts per call. */
class ScriptedAdapter {
  name = 'mock';
  folder = null; // set by a test that saves permission rules
  async folderFor() {
    return this.folder;
  }
  constructor() {
    this.calls = [];
    this.next = [];
    this.forks = [];
  }
  fork(source, target) {
    this.forks.push([source.id, target.id]);
  }
  async deliver(session, message, ctx) {
    this.calls.push({ handle: session.handle, message, sessionId: session.id, state: ctx.state });
    // Each turn ends at a point a topic thread can fork from.
    ctx.checkpoint?.({ turn: this.calls.length });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message, session);
  }
}

function setup(config = {}) {
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, ...config },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha', tools: ['corpus.search'] });
  const b = rt.createPersona({ handle: 'beta' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { store, rt, adapter, t, a, b };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};

test('a message goes to the thread’s agent and its reply streams into an item', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.text('Hello ');
    c.text('there.');
  });
  rt.sendMessage(t.id, { text: 'hi' });
  await settle(rt);
  const items = store.items(t.id);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['user', 'agent'],
  );
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
  adapter.next.push(async (c) => {
    c.text('working');
    await sleep(40);
  });
  rt.sendMessage(t.id, { text: 'first' });
  const r = rt.sendMessage(t.id, { text: 'second' });
  assert.ok(r.queued);
  assert.equal(store.state.threads[t.id].queue.length, 1);
  await settle(rt);
  assert.equal(store.state.threads[t.id].queue.length, 0);
  assert.deepEqual(
    store
      .items(t.id)
      .filter((i) => i.kind === 'user')
      .map((i) => i.text),
    ['first', 'second'],
  );
});

test('Stop ends the turn cleanly and marks the reply stopped', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.text('partial');
    await new Promise((_res, rej) => c.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  });
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
  adapter.next.push(async () => {
    throw Object.assign(new Error('boom'), { userMessage: 'The model didn’t respond.' });
  });
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
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: { id: 'q', type: 'choice', version: 1, fallback: 'Pick', title: 'Pick one', options: [{ id: 'a', label: 'A' }] } });
  });
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
  adapter.next.push(async (c) => {
    result = c.tools.show_block({ block: { id: 'x', type: 'timeline', version: 1, fallback: 'Plain version' } });
  });
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
  const { rt, store, t, adapter } = setup();
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
  assert.ok(
    store
      .items(t.id)
      .filter((i) => i.sessionId === beta.id)
      .every((i) => i.deletedAgent),
  );
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

/** An app in a fresh conversation, owned by its agent. */
function withApp(store = undefined) {
  const s = store ? setupWith(store) : setup();
  const se = s.rt.sessionsIn(s.t.id)[0];
  s.rt.toolsFor(se.id).show_app({ id: 'spam', title: 'Spam', code: '<p>x</p>', permissions: [] });
  return { ...s, se };
}
function setupWith(store) {
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { store, rt, adapter, t, a, b: a };
}
const LIMIT = Runtime.APP_SEND_LIMIT;

test(`#38: an app sends up to ${LIMIT} events a minute in your voice; more wait on a card, and nothing is dropped`, async () => {
  const { rt, store, t, adapter } = withApp();
  const now = 1_000_000;
  for (let i = 0; i < LIMIT; i++) assert.equal(rt.appEvent('spam', 'ok', { i, summary: `Sure #${i}` }, { now: now + i }).held, undefined);
  const r = rt.appEvent('spam', 'ok', { i: LIMIT, summary: 'One too many' }, { now: now + LIMIT });
  assert.equal(r.held, true);
  assert.match(r.message, /waiting/);
  const voices = () => store.items(t.id).filter((x) => x.kind === 'voice' && x.appId === 'spam');
  assert.equal(voices().length, LIMIT, 'the one past the limit isn’t written in your voice');
  // A later send joins the same card, in order, even after the minute is up.
  assert.equal(rt.appEvent('spam', 'ok', { i: 99, summary: 'Later' }, { now: now + 120_000 }).waiting, 2);
  const cards = store.items(t.id).filter((x) => x.kind === 'appsend');
  assert.equal(cards.length, 1);
  assert.deepEqual(
    cards[0].events.map((e) => e.voice),
    ['Sent from Spam: One too many', 'Sent from Spam: Later'],
  );
  assert.equal(cards[0].status, 'open');
  await settle(rt);
  const delivered = adapter.calls.filter((c) => c.message.kind === 'event').length;
  // Allow sends them as they were sent, each a line in your voice and an event for the agent.
  rt.act(t.id, cards[0].id, 'allow');
  await settle(rt);
  assert.equal(store.item(t.id, cards[0].id).status, 'allowed');
  assert.deepEqual(
    voices()
      .slice(-2)
      .map((x) => x.text),
    ['Sent from Spam: One too many', 'Sent from Spam: Later'],
  );
  const events = adapter.calls.filter((c) => c.message.kind === 'event').length - delivered;
  assert.ok(events >= 1, 'the allowed events reach the agent');
  assert.throws(() => rt.act(t.id, cards[0].id, 'allow'), /already answered/);
});

test('#38: a waiting app card makes the agent need you and tells you, until you answer it', () => {
  const { rt, store, t, se } = withApp();
  const notes = [];
  store.subscribe((ev) => ev.type === 'notify' && notes.push(ev.data));
  rt.appEvent('spam', 'ok', { summary: 'Held' }, { hold: true, now: 1 });
  rt.appEvent('spam', 'ok', { summary: 'Held too' }, { hold: true, now: 2 });
  const card = store.items(t.id).find((x) => x.kind === 'appsend');
  assert.deepEqual(store.state.sessions[se.id].needs, { kind: 'appsend', itemId: card.id, text: 'Spam wants to send 2 messages for you' });
  assert.equal(store.state.sessions[se.id].state, 'needs');
  assert.equal(notes.length, 1, 'one notice per card, not per send');
  assert.equal(notes[0].level, 'blocking');
  rt.act(t.id, card.id, 'deny');
  assert.equal(store.state.sessions[se.id].needs, null);
  assert.equal(store.state.sessions[se.id].state, 'idle');
});

test('#38: Don’t allow drops the waiting sends; the browser can ask for a hold; the card has a cap', () => {
  const { rt, store, t } = withApp();
  const r = rt.appEvent('spam', 'ok', { summary: 'Held by the browser' }, { hold: true, now: 1 });
  assert.equal(r.held, true, 'the browser’s own limit can hold a send the server would have taken');
  const card = store.items(t.id).find((x) => x.kind === 'appsend');
  rt.act(t.id, card.id, 'deny');
  assert.equal(store.item(t.id, card.id).status, 'declined');
  assert.ok(!store.items(t.id).some((x) => x.kind === 'voice' && x.text === 'Sent from Spam: Held by the browser'));
  assert.ok(store.items(t.id).some((x) => x.kind === 'voice' && x.text === 'Didn’t allow Spam to send 1 message'));
  // A send after the answer is counted afresh.
  assert.equal(rt.appEvent('spam', 'ok', {}, { now: 2 }).held, undefined);
  for (let i = 0; i < Runtime.APP_HOLD_MAX; i++) rt.appEvent('spam', 'ok', {}, { hold: true, now: 3 });
  assert.throws(() => rt.appEvent('spam', 'ok', {}, { hold: true, now: 3 }), /already waiting/);
  assert.throws(() => rt.appEvent('spam', 'nope nope', {}), /short id/, 'values are still checked at the boundary');
});

test('#38: an app’s waiting sends survive a restart, and Allow still sends them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-appsend-'));
  const first = withApp(await new Store(dir).load());
  for (let i = 0; i <= LIMIT; i++) first.rt.appEvent('spam', 'ok', { summary: `#${i}` }, { now: 10 + i });
  await settle(first.rt);
  await first.store.flush();
  const store = await new Store(dir).load();
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  const card = store.items(first.t.id).find((x) => x.kind === 'appsend');
  assert.equal(card?.status, 'open');
  assert.equal(card.events.length, 1);
  rt.act(first.t.id, card.id, 'allow');
  await settle(rt);
  assert.ok(store.items(first.t.id).some((x) => x.kind === 'voice' && x.text === `Sent from Spam: #${LIMIT}` && x.approved));
  assert.ok(adapter.calls.some((c) => c.message.kind === 'event' && c.message.event.blockId === 'spam'));
});

test('MCP: initialize, list tools, and a tool call that returns at once', async () => {
  const { rt, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const init = await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'postbox');
  assert.equal(await handleMcp(rt, se.id, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const tools = (await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((x) => x.name);
  assert.ok(tools.includes('show_block') && tools.includes('wake_agent'));
  const r = await handleMcp(rt, se.id, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'show_block', arguments: { block: { id: 'c', type: 'confirm', version: 1, fallback: 'x', statement: 'Do it?', confirmLabel: 'Do it' } } },
  });
  assert.equal(r.result.isError, false);
  const bad = await handleMcp(rt, 'nope', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'show_block', arguments: {} } });
  assert.match(bad.error.message, /Unknown Postbox session/);
  assert.equal((await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
});

test('a permission prompt shows a card, makes the agent need you, and waits for your answer', async () => {
  const { rt, store, t, adapter } = setup();
  const answers = [];
  adapter.next.push(async (c) => {
    answers.push(await c.askPermission({ tool: 'Bash', summary: 'run a command', detail: 'npm test' }));
    answers.push(await c.askPermission({ tool: 'Bash', summary: 'run a command', detail: 'rm -rf build' }));
    c.text('Done.');
  });
  rt.sendMessage(t.id, { text: 'test it' });
  await sleep(20);
  const se = rt.sessionsIn(t.id)[0];
  let card = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
  assert.equal(card.detail, 'npm test');
  assert.equal(store.state.sessions[se.id].state, 'needs');
  assert.equal(store.state.sessions[se.id].needs.kind, 'permission');
  rt.act(t.id, card.id, 'allow');
  await sleep(20);
  card = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
  rt.act(t.id, card.id, 'deny');
  await settle(rt);
  assert.equal(answers[0].allow, true);
  assert.equal(answers[1].allow, false);
  assert.match(answers[1].message, /didn’t allow/);
  assert.deepEqual(
    store
      .items(t.id)
      .filter((i) => i.kind === 'voice')
      .map((i) => i.text),
    ['Allowed: @alpha to run a command', 'Didn’t allow: @alpha to run a command'],
  );
  assert.throws(() => rt.act(t.id, card.id, 'allow'), /already answered/);
});

test('Stop expires an open permission card and answers no', async () => {
  const { rt, store, t, adapter } = setup();
  let answer = null;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Write', summary: 'write notes.md' });
  });
  rt.sendMessage(t.id, { text: 'write it' });
  await sleep(20);
  const se = rt.sessionsIn(t.id)[0];
  rt.stop(se.id);
  await sleep(10);
  assert.equal(answer.allow, false);
  assert.equal(store.items(t.id).find((i) => i.kind === 'permission').status, 'expired');
});

test('MCP permission_prompt answers in the shape Claude Code expects', async () => {
  const { rt, store, t, adapter } = setup();
  let reply = null;
  adapter.next.push(async (c) => {
    const se = rt.sessionsIn(t.id)[0];
    const pending = handleMcp(rt, se.id, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'ls', description: 'List files' } } },
    });
    await sleep(10);
    const card = store.items(t.id).find((i) => i.kind === 'permission');
    assert.equal(card.summary, 'run a command: List files');
    rt.act(t.id, card.id, 'allow');
    reply = await pending;
    c.text('ok');
  });
  rt.sendMessage(t.id, { text: 'list' });
  await settle(rt);
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { behavior: 'allow', updatedInput: { command: 'ls', description: 'List files' } });
});

test('personas keep a permission mode and a model; real backends default to Claude Opus 5.5', () => {
  const { rt } = setup();
  rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code' });
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.permissionMode, 'auto', 'auto mode is the default');
  assert.equal(rt.updatePersona(p.id, { permissionMode: 'acceptEdits' }).permissionMode, 'acceptEdits');
  assert.throws(() => rt.updatePersona(p.id, { permissionMode: 'yolo' }), /Permissions are one of/);
  assert.throws(() => rt.createPersona({ handle: 'nope', backend: 'agent-sdk' }), /isn’t available on this computer/);
});

test('attachments resolve to stored files, and project files stay inside the project folder', () => {
  const { rt, store, t } = setup();
  rt.blobs = { pathOf: (sha) => `/data/blobs/${sha.slice(0, 2)}/${sha}` };
  store.emit('file', { id: 'fi1', name: 'a.png', sha256: 'ab12' });
  assert.equal(rt.attachmentPath(t.id, { kind: 'file', fileId: 'fi1' }), '/data/blobs/ab/ab12');
  assert.equal(rt.attachmentPath(t.id, { kind: 'project-file', path: 'notes/x.md' }), '/tmp/notes/x.md');
  assert.equal(rt.attachmentPath(t.id, { kind: 'project-file', path: '../etc/passwd' }), null);
});

test('a session keeps the persona it started with; edits apply to new sessions', async () => {
  const { rt, t, a, adapter } = setup();
  rt.updatePersona(a.id, { instructions: 'Old.' });
  const t2 = rt.createThread({ projectId: 'p1', title: 'T2', personaIds: [a.id] });
  rt.updatePersona(a.id, { instructions: 'New.' });
  const seen = [];
  adapter.next.push(async (c) => seen.push(c.persona.instructions));
  adapter.next.push(async (c) => seen.push(c.persona.instructions));
  rt.sendMessage(t2.id, { text: 'hi' });
  await settle(rt);
  const t3 = rt.createThread({ projectId: 'p1', title: 'T3', personaIds: [a.id] });
  rt.sendMessage(t3.id, { text: 'hi' });
  await settle(rt);
  assert.deepEqual(seen, ['Old.', 'New.']);
  assert.ok(t);
});

// ── Topic threads ─────────────────────────────────────────────────────────────────────────

async function conversation() {
  const ctx = setup();
  const { rt, t, adapter } = ctx;
  adapter.next.push(async (c) => c.text('First answer.'));
  rt.sendMessage(t.id, { text: 'First question' });
  await settle(rt);
  adapter.next.push(async (c) => c.text('Second answer.'));
  rt.sendMessage(t.id, { text: 'Second question' });
  await settle(rt);
  return ctx;
}

test('a topic thread from an agent’s reply forks its session at that reply', async () => {
  const { rt, store, t, adapter } = await conversation();
  const items = store.items(t.id);
  const first = items.find((i) => i.kind === 'agent' && i.text === 'First answer.');
  assert.deepEqual(first.checkpoint, { turn: 1 });
  const { threadId } = rt.startTopic(t.id, first.id);
  const topic = store.state.threads[threadId];
  assert.equal(topic.kind, 'topic');
  assert.equal(topic.parentId, t.id);
  assert.equal(store.item(t.id, first.id).topicId, threadId);
  const [fork] = rt.sessionsIn(threadId);
  assert.deepEqual(fork.backendState.fork, { turn: 1 }, 'it remembers up to the first answer, not the second');
  assert.equal(fork.forkOf.itemId, first.id);
  assert.deepEqual(adapter.forks, [[rt.sessionsIn(t.id)[0].id, fork.id]]);
  assert.equal(rt.startTopic(t.id, first.id).threadId, threadId, 'a message has one thread');
  // The first reply in the thread tells the agent where it branched from; the conversation isn’t woken.
  adapter.next.push(async (c) => c.text('Thread answer.'));
  rt.sendMessage(threadId, { text: 'Why?' });
  await settle(rt);
  const call = adapter.calls.at(-1);
  assert.equal(call.sessionId, fork.id);
  assert.match(call.message.context[0], /topic thread that branches from @alpha’s message/);
  assert.equal(store.item(t.id, first.id).replies, 2);
  assert.equal(store.items(t.id).length, items.length, 'nothing was added to the conversation');
  assert.throws(() => rt.startTopic(threadId, store.items(threadId)[0].id), /can’t start another/);
});

test('a topic thread from your message forks the agent that answered, before its answer', async () => {
  const { rt, store, t } = await conversation();
  const second = store.items(t.id).find((i) => i.kind === 'user' && i.text === 'Second question');
  const { threadId } = rt.startTopic(t.id, second.id);
  const [fork] = rt.sessionsIn(threadId);
  assert.deepEqual(fork.backendState.fork, { turn: 1 });
  assert.equal(fork.handle, 'alpha');
});

test('sending a reply to the conversation reaches its agent on its next turn, without waking it', async () => {
  const { rt, store, t, adapter } = await conversation();
  const first = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, first.id);
  adapter.next.push(async (c) => c.text('Use chapter offsets.'));
  rt.sendMessage(threadId, { text: 'Offsets or pages?' });
  await settle(rt);
  const reply = store.items(threadId).find((i) => i.kind === 'agent');
  const calls = adapter.calls.length;
  rt.shareToConversation(threadId, reply.id);
  const shared = store.items(t.id).at(-1);
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.text, 'Use chapter offsets.');
  assert.equal(adapter.calls.length, calls, 'sharing costs no turn');
  assert.throws(() => rt.shareToConversation(threadId, reply.id), /already in the conversation/);
  rt.sendMessage(t.id, { text: 'Carry on' });
  await settle(rt);
  assert.match(adapter.calls.at(-1).message.context[0], /Shared from the thread .*Use chapter offsets\./s);
});

test('summarize back posts the thread agent’s summary in the conversation', async () => {
  const { rt, store, t, adapter } = await conversation();
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((i) => i.kind === 'agent').id);
  adapter.next.push(async (c) => c.text('We chose offsets over pages.'));
  rt.summarizeBack(threadId);
  await settle(rt);
  const shared = store.items(t.id).at(-1);
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.summary, true);
  assert.equal(shared.text, 'We chose offsets over pages.');
  assert.match(adapter.calls.at(-1).message.text, /Summarize this topic thread/);
});

test('@-mentioning a conversation’s other agent in a topic forks its session too', async () => {
  const { rt, store, t, b, adapter } = await conversation();
  rt.sendMessage(t.id, { text: '@beta hello' });
  await settle(rt);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  rt.sendMessage(threadId, { text: '@beta what do you think?' });
  await settle(rt);
  const betaFork = rt.sessionsIn(threadId).find((x) => x.personaId === b.id);
  assert.ok(betaFork.forkOf);
  assert.equal(adapter.forks.length, 2);
});

test('moving a persona from the mock to a real backend gives it the default model, and its conversations follow', async () => {
  const { rt, store, t, a } = setup();
  const calls = [];
  rt.adapters.register({ name: 'claude-code', deliver: async (_se, _m, c) => calls.push(c.persona.model) });
  assert.equal(store.state.personas[a.id].model, 'mock');
  const p = rt.updatePersona(a.id, { backend: 'claude-code' });
  assert.equal(p.backend, 'claude-code');
  assert.equal(p.model, 'claude-opus-5-5');
  rt.sendMessage(t.id, { text: 'hi' });
  await settle(rt);
  assert.equal(calls.length, 1, 'the existing conversation now runs on Claude Code');
  assert.throws(() => rt.updatePersona(a.id, { backend: 'nope' }), /isn’t available/);
});

test('deleting a conversation removes its sessions, apps and threads after the undo window, and can be undone', () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const r = rt.deleteThread(t.id);
  assert.ok(r.until > Date.now());
  assert.ok(store.state.threads[t.id].deleting);
  rt.undoDeleteThread(t.id);
  assert.equal(store.state.threads[t.id].deleting, null);
  rt.deleteThread(t.id);
  rt.purgeThread(t.id);
  assert.equal(store.state.threads[t.id], undefined);
  assert.equal(store.state.sessions[se.id], undefined);
  assert.ok(store.state.personas[se.personaId], 'the persona stays');
  for (const k of rt.timers.keys()) clearTimeout(rt.timers.get(k));
});

test('a conversation being deleted takes no new messages', () => {
  const { rt, store, t } = setup();
  rt.deleteThread(t.id);
  assert.throws(() => rt.sendMessage(t.id, { text: 'still there?' }), /being deleted/);
  assert.equal(store.items(t.id).length, 0);
  for (const k of rt.timers.keys()) clearTimeout(rt.timers.get(k));
});

test('a message to an archived agent is refused before anything is posted', () => {
  const { rt, store, a, b } = setup();
  const room = rt.createThread({ projectId: 'p1', title: 'Room', personaIds: [a.id, b.id] });
  const beta = rt.sessionsIn(room.id).find((x) => x.personaId === b.id);
  rt.archive(beta.id);
  assert.throws(() => rt.sendMessage(room.id, { text: '@beta hello' }), /archived/);
  assert.equal(store.items(room.id).length, 0, 'no user line and no wake line');
});

test('deletions still pending when the server stopped finish after a restart', async () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  store.emit('thread', { ...store.state.threads[t.id], deleting: Date.now() - 1 });
  rt.rearmDeletions();
  await sleep(5);
  assert.equal(store.state.threads[t.id], undefined);
  assert.equal(store.state.sessions[se.id], undefined);
});

test('a conversation with several agents is a room, and can be renamed', () => {
  const { rt, a, b } = setup();
  const room = rt.createThread({ projectId: 'p1', title: 'Planning', personaIds: [a.id, b.id] });
  assert.equal(room.kind, 'room');
  assert.equal(rt.renameThread(room.id, '  Corpus planning ').title, 'Corpus planning');
  assert.throws(() => rt.renameThread(room.id, ' '), /needs a name/);
});

// ── Diagram legibility ────────────────────────────────────────────────────────────────

const WIDE_DIAGRAM =
  '```mermaid\nflowchart LR\n  A[Read the plain-text files] --> B[Strip the license headers]\n  B --> C[Detect chapter headings]\n  C --> D[Split into passages]\n  D --> E[Tokenize and lowercase]\n  E --> F[Build the inverted index]\n  F --> G[Write the manifest]\n```';

test('a reply with a diagram too wide to read gets a lint message, once; the redraw isn’t linted again', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text(`Here it is:\n\n${WIDE_DIAGRAM}`));
  adapter.next.push(async (c) => c.text('Redrawn:\n\n```mermaid\nflowchart TD\nA-->B\n```'));
  rt.sendMessage(t.id, { text: 'draw it' });
  await settle(rt);
  const lint = adapter.calls.find((c) => c.message.kind === 'lint');
  assert.equal(lint.message.diagrams[0].problems[0].code, 'text-too-small');
  assert.equal(adapter.calls.filter((c) => c.message.kind === 'lint').length, 1);
  const redraw = store.items(t.id).find((i) => i.kind === 'agent' && i.lintReply);
  assert.ok(redraw, 'the reply to the lint is marked, so the browser check skips it');
});

test('the browser’s measurement reaches the agent only for an unflagged diagram at the conversation’s width', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('```mermaid\ngraph LR\nA-->B\n```'));
  rt.sendMessage(t.id, { text: 'draw' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'agent');
  const src = 'graph LR\nA-->B';
  assert.equal(rt.diagramCheck(t.id, item.id, { src, textPx: 12, width: 728 }).sent, false, 'readable');
  assert.equal(rt.diagramCheck(t.id, item.id, { src, textPx: 7, width: 400 }).sent, false, 'a narrow panel doesn’t count');
  assert.equal(rt.diagramCheck(t.id, item.id, { src, textPx: 7, width: 728 }).sent, true);
  assert.equal(rt.diagramCheck(t.id, item.id, { src, textPx: 7, width: 728 }).sent, false, 'once per diagram');
  await settle(rt);
  assert.match(adapter.calls.at(-1).message.diagrams[0].problems[0].message, /drawn at 7 px/);
});

// ── The lint pipeline ─────────────────────────────────────────────────────────────────

const lints = (adapter) => adapter.calls.filter((c) => c.message.kind === 'lint');

test('the problems of one turn, from the server and the browser, reach the agent as one lint turn', async () => {
  const { rt, store, t, adapter } = setup({ lintSettleMs: 40 });
  adapter.next.push(async (c) => c.text('In Step 7 we index.\n\n```mermaid\ngraph LR\nA-->B\n```\n\n```mermaid\ngraph TD\nC-->D\n```'));
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'agent');
  // The browser measures the diagram a moment after the turn ends, before the lint turn goes.
  assert.equal(rt.diagramCheck(t.id, item.id, { src: 'graph LR\nA-->B', textPx: 7, width: 728 }).sent, true);
  await sleep(60);
  await settle(rt);
  assert.equal(lints(adapter).length, 1);
  const m = lints(adapter)[0].message;
  assert.deepEqual(
    m.problems.map((p) => [p.code, p.scope.kind]),
    [
      ['undefined-term', 'term'],
      ['text-too-small', 'diagram'],
    ],
  );
  // The mock backend reads the same problems as lists.
  assert.deepEqual(m.undefinedTerms, [{ term: 'Step 7', key: 'step-7' }]);
  assert.equal(m.diagrams[0].problems[0].code, 'text-too-small');
  // Once the lint turn has gone, a later report for that turn doesn’t start another.
  assert.equal(rt.diagramCheck(t.id, item.id, { src: 'graph TD\nC-->D', textPx: 7, width: 728 }).sent, false);
  await sleep(60);
  assert.equal(lints(adapter).length, 1);
});

test('a lint turn isn’t linted, and one that only defines terms shows as a one-line note', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('Step 2 and Step 3 come next.'));
  adapter.next.push(async (c, m) => {
    for (const u of m.undefinedTerms) c.activity({ id: u.key, label: 'define_term', state: 'done' });
    for (const u of m.undefinedTerms) c.tools.define_term({ term: u.term, definition: 'A step.' });
  });
  rt.sendMessage(t.id, { text: 'plan it' });
  await settle(rt);
  assert.equal(lints(adapter).length, 1);
  const agents = store.items(t.id).filter((i) => i.kind === 'agent');
  assert.equal(agents.length, 1, 'no empty reply for the lint turn');
  const note = store.items(t.id).find((i) => i.kind === 'system' && i.variant === 'lint');
  assert.equal(note.text, '@alpha defined “Step 2” and “Step 3”');
  assert.equal(note.lintReply, true);
});

test('a lint turn that writes is a reply, marked so the browser’s checks skip it', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('See Step 4.'));
  adapter.next.push(async (c) => {
    c.activity({ id: 'd', label: 'define_term', state: 'done' });
    c.text('Defined it, and Step 9 too.');
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.lintReply);
  assert.equal(reply.activity.steps.length, 1, 'the tool calls before its text are kept');
  assert.equal(lints(adapter).length, 1, 'its own undefined term isn’t linted');
  assert.equal(store.items(t.id).filter((i) => i.kind === 'system' && i.variant === 'lint').length, 0);
});

test('a message during the settle takes the lint’s problems with it, and no lint turn lands after it', async () => {
  const { rt, store, t, adapter } = setup({ lintSettleMs: 40 });
  adapter.next.push(async (c) => c.text('Step 6 is done.\n\n```mermaid\ngraph LR\nA-->B\n```'));
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  rt.sendMessage(t.id, { text: 'and next?' });
  const item = store.items(t.id).find((i) => i.kind === 'agent');
  await settle(rt);
  // The browser’s report for the earlier reply comes in after the person’s turn began.
  assert.equal(rt.diagramCheck(t.id, item.id, { src: 'graph LR\nA-->B', textPx: 7, width: 728 }).sent, false);
  await sleep(80);
  await settle(rt);
  assert.equal(lints(adapter).length, 0);
  const next = adapter.calls.find((c) => c.message.text === 'and next?');
  assert.match(next.message.context[0], /^\[Postbox\] Postbox checked your last reply/);
  assert.match(next.message.context[0], /- Step 6/);
});

test('#55: a numbered term the person introduced isn’t linted, and one the agent coined still is', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: { id: 'plan', type: 'card', version: 1, title: 'Phase 4 checklist', fallback: 'Plan' } });
    c.text('Agreed: Step 2 gets highlights, Phase 4 follows, and Step 8 is new.');
  });
  rt.sendMessage(t.id, { text: 'I think step 2 should show matched text as a highlight.' });
  await settle(rt);
  assert.deepEqual(
    lints(adapter)[0].message.undefinedTerms.map((u) => u.term),
    ['Step 8'],
  );
});

test('#55: a term the person used in the conversation or its parent isn’t linted', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('Noted.'));
  rt.sendMessage(t.id, { text: 'Build an eval: say 20 questions, distractor setting, with supporting facts.' });
  await settle(rt);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId: topic } = rt.startTopic(t.id, root.id);
  adapter.next.push(async (c) =>
    c.text('The [distractor setting](term:distractor-setting) keeps [supporting facts](term:supporting-facts) next to a [bridge entity](term:bridge-entity).'),
  );
  rt.sendMessage(topic, { text: 'go on' });
  await settle(rt);
  assert.deepEqual(
    lints(adapter)[0].message.undefinedTerms.map((u) => u.term),
    ['bridge entity'],
  );
});

test('#56: a topic thread uses its conversation’s terms, and its own definition wins there', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.define_term({ term: 'Step 2', definition: 'Show matches as highlights.' });
    c.text('Step 2 is next.');
  });
  rt.sendMessage(t.id, { text: 'plan it' });
  await settle(rt);
  assert.equal(lints(adapter).length, 0);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId: topic } = rt.startTopic(t.id, root.id);
  adapter.next.push(async (c) => c.text('Step 2 looks right to me.'));
  rt.sendMessage(topic, { text: 'check it' });
  await settle(rt);
  assert.equal(lints(adapter).length, 0, 'the parent’s term isn’t linted in the topic');
  assert.equal(rt.glossaryFor(topic)['step-2'].definition, 'Show matches as highlights.');
  const r = rt.toolsFor(adapter.calls.at(-1).sessionId).define_term({ term: 'Step 2', definition: 'Quote the match instead.' });
  assert.match(r.message, /over the conversation’s definition/);
  assert.equal(rt.glossaryFor(topic)['step-2'].definition, 'Quote the match instead.');
  assert.equal(rt.glossaryFor(t.id)['step-2'].definition, 'Show matches as highlights.', 'the conversation keeps its own');
});

test('raw HTML in a reply reaches the agent through the lint turn', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('Try it.<br><details><summary>Answer</summary>50%</details>'));
  rt.sendMessage(t.id, { text: 'quiz me' });
  await settle(rt);
  assert.deepEqual(
    lints(adapter)[0].message.problems.map((p) => p.message.match(/\(([^)]*)\)/)[1]),
    ['<br>'],
  );
});

test('a report the reply doesn’t match, or about a turn this runtime never saw end, starts nothing', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('```mermaid\ngraph LR\nA-->B\n```'));
  rt.sendMessage(t.id, { text: 'draw' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'agent');
  assert.equal(rt.diagramCheck(t.id, item.id, { src: 'graph LR\nX-->Y', textPx: 7, width: 728 }).sent, false, 'not a diagram in the reply');
  // After a restart, the old reply’s turn has no entry: a broken diagram in it doesn’t start a lint turn.
  rt.lints.clear();
  assert.equal(rt.diagramCheck(t.id, item.id, { src: 'graph LR\nA-->B', error: { message: 'Parse error', line: 1 } }).sent, false);
  await settle(rt);
  assert.equal(lints(adapter).length, 0);
});

test('what a lint turn shows is never linted, so lint turns can’t chain', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('Step 3 next.'));
  adapter.next.push(async (c) => c.tools.show_app({ id: 'fix', title: 'Fix', code: '<svg></svg>' }));
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.equal(lints(adapter).length, 1);
  rt.appCheck('fix', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny.' }] });
  await settle(rt);
  assert.equal(lints(adapter).length, 1);
});

test('#53: warnings for a version made in a later turn reach that turn’s lint turn', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => c.tools.show_app({ id: 'dots', title: 'Dots', code: '<svg></svg>' }));
  adapter.next.push(async (c) => c.tools.update_app({ id: 'dots', code: '<svg><circle r="1"/></svg>', summary: 'bigger dots' }));
  rt.sendMessage(t.id, { text: 'draw' });
  await settle(rt);
  rt.appCheck('dots', { version: 1, problems: [] });
  rt.sendMessage(t.id, { text: 'make the dots bigger' });
  await settle(rt);
  rt.appCheck('dots', { version: 2, problems: [{ code: 'marks-too-small', message: 'Still tiny.' }] });
  await settle(rt);
  assert.deepEqual(
    lints(adapter).map((c) => c.message.problems[0].message),
    ['Still tiny.'],
  );
});

test('#58: only Postbox marks a step stalled', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: progress([{ id: 'a', label: 'Read A', state: 'pending' }]) });
    c.tools.update_block({ block: progress([{ id: 'a', label: 'Read A', state: 'stalled' }]) });
    c.tools.update_block({ block: progress([{ id: 'a', label: 'Read A', state: 'done' }]) });
  });
  rt.sendMessage(t.id, { text: 'read' });
  await settle(rt);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.equal(it.block.steps[0].state, 'done');
  assert.ok(it.stepTimes.a.startedAt && it.stepTimes.a.endedAt, 'the agent’s “stalled” counted as running');
});

test('problems from a turn that failed don’t reach the agent', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.text('Step 5 broke.');
    throw new Error('boom');
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'agent');
  assert.equal(item.status, 'failed');
  assert.equal(rt.diagramCheck(t.id, item.id, { src: 'graph LR\nA-->B', textPx: 7, width: 728 }).sent, false);
  assert.equal(lints(adapter).length, 0);
});

test('#46: a diagram the browser couldn’t draw comes back to the agent once, with Mermaid’s message and line', async () => {
  const { rt, store, t, adapter } = setup();
  const broken = 'graph LR\nA -->> B';
  adapter.next.push(async (c) => c.text(`Two diagrams.\n\n\`\`\`mermaid\ngraph TD\nX-->Y\n\`\`\`\n\n\`\`\`mermaid\n${broken}\n\`\`\``));
  rt.sendMessage(t.id, { text: 'draw' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'agent');
  const error = { message: "Parse error on line 2:\nA -->> B\n----^\nExpecting 'SEMI', got 'ARROW'", line: 2 };
  assert.equal(rt.diagramCheck(t.id, item.id, { src: broken, error }).sent, true);
  assert.equal(rt.diagramCheck(t.id, item.id, { src: broken, error }).sent, false, 'once per diagram');
  await settle(rt);
  assert.equal(lints(adapter).length, 1);
  const [p] = lints(adapter)[0].message.problems;
  assert.equal(p.code, 'diagram-error');
  assert.deepEqual(p.scope, { kind: 'diagram', index: 1, excerpt: broken });
  assert.equal(
    p.message,
    "Mermaid couldn’t draw it, so the person sees an error and its source instead. Mermaid said (line 2): “Parse error on line 2: A -->> B Expecting 'SEMI', got 'ARROW'”. Fix the syntax.",
  );
});

test('#53: an app check with only warnings shows the app with notes, and tells the agent in its lint turn', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_app({ id: 'pairs', title: 'Pair explorer', code: '<svg></svg>' });
    c.text('Here’s the explorer.');
  });
  rt.sendMessage(t.id, { text: 'build it' });
  await settle(rt);
  const tiny = { code: 'marks-too-small', message: 'At 1280 px, 1,200 of 1,258 marks are under 4 px across.' };
  assert.deepEqual(rt.appCheck('pairs', { version: 1, problems: [tiny] }), { status: 'note' });
  await settle(rt);
  assert.equal(store.state.apps.pairs.check.status, 'note');
  assert.equal(store.state.apps.pairs.check.notes, true, 'the browser words it as notes, not a failure');
  assert.equal(adapter.calls.filter((c) => c.message.kind === 'app-check').length, 0);
  const [lint] = lints(adapter);
  assert.deepEqual(lint.message.problems, [{ ...tiny, scope: { kind: 'app', id: 'pairs', title: 'Pair explorer' } }]);
});

test('#53: warnings with a real failure go back with it in the app-check turn', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.tools.show_app({ id: 'pairs', title: 'Pair explorer', code: '<svg></svg>' }));
  rt.sendMessage(t.id, { text: 'build it' });
  await settle(rt);
  const problems = [
    { code: 'only-error', message: 'It shows only “SciFact isn’t loaded”.' },
    { code: 'unlabeled-field', message: 'A select has no label.' },
  ];
  assert.deepEqual(rt.appCheck('pairs', { version: 1, problems }), { status: 'fixing' });
  await settle(rt);
  assert.deepEqual(
    adapter.calls.find((c) => c.message.kind === 'app-check').message.problems.map((p) => p.code),
    ['only-error', 'unlabeled-field'],
  );
  assert.equal(lints(adapter).length, 0);
  assert.equal(store.state.apps.pairs.check.status, 'note', 'the fix turn ended without a new version');
  assert.equal(store.state.apps.pairs.check.notes, undefined);
});

// ── Progress blocks (#58) ─────────────────────────────────────────────────────────────

const progress = (steps) => ({ id: 'job', type: 'progress', version: 1, title: 'Reading', fallback: 'Reading papers', steps });

test('#58: update_block stamps when a progress block moved and when each step ran, and fills in durations', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'running' },
        { id: 'b', label: 'Read B', state: 'pending' },
      ]),
    });
    await sleep(15);
    c.tools.update_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'done' },
        { id: 'b', label: 'Read B', state: 'running', progress: { done: 2, total: 4, unit: 'papers' } },
      ]),
    });
    c.tools.update_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'done' },
        { id: 'b', label: 'Read B', state: 'done', duration: '2 min' },
      ]),
    });
  });
  rt.sendMessage(t.id, { text: 'read' });
  await settle(rt);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.ok(it.updatedAt >= it.at);
  assert.equal(it.stepTimes.a.startedAt, it.at, 'running since it was shown');
  assert.ok(it.stepTimes.a.endedAt > it.at);
  assert.ok(it.stepTimes.b.startedAt && it.stepTimes.b.endedAt);
  assert.match(it.block.steps[0].duration, /^\d/, 'filled in from the times');
  assert.equal(it.block.steps[1].duration, '2 min', 'the agent’s own duration stays');
  assert.equal(lints(adapter).length, 0, 'nothing was left running');
});

test('#58: steps left running when the turn ends are marked stalled, and the agent is told once', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'running' },
        { id: 'b', label: 'Read B', state: 'done' },
      ]),
    });
  });
  adapter.next.push(async (c) => {
    // The lint turn sets it running again and ends: shown stalled again, without another lint turn.
    c.tools.update_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'running' },
        { id: 'b', label: 'Read B', state: 'done' },
      ]),
    });
  });
  rt.sendMessage(t.id, { text: 'read' });
  await settle(rt);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.deepEqual(
    it.block.steps.map((s) => s.state),
    ['stalled', 'done'],
  );
  assert.ok(it.stalledAt);
  assert.equal(lints(adapter).length, 1);
  const [p] = lints(adapter)[0].message.problems;
  assert.equal(p.code, 'steps-left-running');
  assert.deepEqual(p.scope, { kind: 'block', id: 'job', title: 'Reading' });
  assert.match(p.message, /^Step “Read A” was still running when your turn ended/);
  assert.equal(it.stepTimes.a.startedAt, it.at, 'resuming a stalled step keeps its start');
});

test('#69: an asking block asked again with update_block belongs to the turn that asked', async () => {
  const { rt, store, t, adapter } = setup();
  const form = (label) => ({ id: 'q', type: 'form', version: 1, fallback: 'Questions', fields: [{ id: 'f', label, kind: 'text' }] });
  adapter.next.push(async (c) => c.tools.show_block({ block: form('First?') }));
  adapter.next.push(async (c) => {
    c.tools.update_block({ block: form('Second?') });
    c.text('Asked again.');
  });
  rt.sendMessage(t.id, { text: 'ask' });
  await settle(rt);
  const first = store.items(t.id).find((i) => i.kind === 'block').turnId;
  rt.sendMessage(t.id, { text: 'ask again' });
  await settle(rt);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  const second = store.items(t.id).find((i) => i.kind === 'agent' && i.text === 'Asked again.').turnId;
  assert.notEqual(second, first);
  assert.equal(it.turnId, second);
});

test('a persona’s permission mode reaches its running conversations from their next turn', async () => {
  const { rt, t, a, adapter } = setup();
  const seen = [];
  adapter.next.push(async (c) => seen.push(c.persona.permissionMode));
  adapter.next.push(async (c) => seen.push(c.persona.permissionMode));
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  rt.updatePersona(a.id, { permissionMode: 'ask' });
  rt.sendMessage(t.id, { text: 'two' });
  await settle(rt);
  assert.deepEqual(seen, ['auto', 'ask']);
});

test('#57: a persona uses your Claude Code setup and can’t publish outside Postbox, unless it’s set otherwise', () => {
  const { rt, store } = setup();
  const p = rt.createPersona({ handle: 'coder' });
  assert.deepEqual([p.usesHostSetup, p.canPublish], [true, false], 'the defaults');
  const q = rt.createPersona({ handle: 'loner', usesHostSetup: false, canPublish: true });
  assert.deepEqual([q.usesHostSetup, q.canPublish], [false, true]);
  for (const bad of ['yes', 1, null, 'false', {}]) {
    assert.throws(
      () => rt.createPersona({ handle: 'nope', usesHostSetup: bad }),
      (e) => e.status === 422 && /Uses your Claude Code setup/.test(e.message),
    );
    assert.throws(
      () => rt.createPersona({ handle: 'nope', canPublish: bad }),
      (e) => e.status === 422 && /Can publish outside Postbox/.test(e.message),
    );
    assert.throws(
      () => rt.updatePersona(p.id, { usesHostSetup: bad }),
      (e) => e.status === 422,
    );
    assert.throws(
      () => rt.updatePersona(p.id, { canPublish: bad }),
      (e) => e.status === 422,
    );
  }
  assert.ok(!rt.personaByHandle('nope'), 'nothing was created');
  const r = rt.updatePersona(p.id, { usesHostSetup: false, canPublish: true });
  assert.deepEqual([r.usesHostSetup, r.canPublish], [false, true]);
  assert.deepEqual([rt.updatePersona(p.id, { description: 'x' }).usesHostSetup, store.state.personas[p.id].canPublish], [false, true], 'other edits keep them');
});

test('#57: setup choices are in a session’s snapshot, and like permissions they follow the persona from the next turn', async () => {
  const { rt, t, a, adapter, store } = setup();
  // A persona from before the fields existed gets the defaults.
  assert.equal(store.state.personas[a.id].usesHostSetup, true);
  store.emit('persona', { ...store.state.personas[a.id], usesHostSetup: undefined, canPublish: undefined });
  const seen = [];
  adapter.next.push(async (c) => seen.push([c.persona.usesHostSetup, c.persona.canPublish]));
  adapter.next.push(async (c) => seen.push([c.persona.usesHostSetup, c.persona.canPublish]));
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  rt.updatePersona(a.id, { usesHostSetup: false, canPublish: true });
  rt.sendMessage(t.id, { text: 'two' });
  await settle(rt);
  assert.deepEqual(seen, [
    [true, false],
    [false, true],
  ]);
  const t2 = rt.createThread({ projectId: 'p1', title: 'T2', personaIds: [a.id] });
  const snap = rt.sessionsIn(t2.id)[0].personaSnapshot;
  assert.deepEqual([snap.usesHostSetup, snap.canPublish], [false, true], 'a new session records what it was created with');
});

// ── Shared memory in a conversation (issue #1) ─────────────────────────────────────────

test('issue #1: an agent mentioned into a room gets the exchange it wasn’t woken for', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('The editions differ in chapter 12.'));
  rt.sendMessage(t.id, { text: 'Which edition of Emma should we index?' });
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta what did alpha say about the editions?' });
  await settle(rt);
  const b = adapter.calls.at(-1);
  assert.equal(b.handle, 'beta');
  assert.equal(b.message.text, '@beta what did alpha say about the editions?');
  const ctx = b.message.context[0];
  assert.match(ctx, /^\[Postbox\] What happened in this room since your last turn:/);
  assert.match(ctx, /You: Which edition of Emma should we index\?/);
  assert.match(ctx, /@alpha: The editions differ in chapter 12\./);
  assert.ok(!ctx.includes('what did alpha say'), 'the message itself isn’t repeated as context');
});

test('each agent catches up only on what it missed, and never on its own replies', async () => {
  const { rt, t, adapter } = setup();
  rt.sendMessage(t.id, { text: '@beta hi' });
  await settle(rt);
  adapter.next.push(async (c) => c.text('Alpha here.'));
  rt.sendMessage(t.id, { text: '@alpha status?' });
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta and you?' });
  await settle(rt);
  const ctx = adapter.calls.at(-1).message.context?.[0] ?? '';
  assert.match(ctx, /You: @alpha status\?/);
  assert.match(ctx, /@alpha: Alpha here\./);
  assert.ok(!ctx.includes('@beta hi'), 'beta already had that');
  assert.ok(!/@beta: /.test(ctx), 'its own replies aren’t played back');
  // In a one-agent conversation nothing is missed, so there’s no catch-up.
  const { rt: rt2, t: t2, adapter: a2 } = setup();
  rt2.sendMessage(t2.id, { text: 'one' });
  await settle(rt2);
  rt2.sendMessage(t2.id, { text: 'two' });
  await settle(rt2);
  assert.equal(a2.calls.at(-1).message.context, undefined);
});

test('a long history is capped, says so, and read_conversation has the rest', async () => {
  const { rt, store, t, b } = setup();
  for (let i = 0; i < 60; i++) store.emit('item.add', { threadId: t.id, item: { id: `old${i}`, kind: 'user', text: `message ${i}`, at: i } });
  const se = rt.ensureSession(t.id, b.id);
  const ctx = rt.catchUp(se);
  assert.match(ctx, /the last 40; 20 earlier items are left out, and read_conversation has them/);
  assert.ok(ctx.includes('message 59') && !ctx.includes('message 19\n'));
  const r = rt.toolsFor(se.id).read_conversation({ limit: 5, skip: 0 });
  assert.match(r.message, /You: message 59/);
  assert.match(r.message, /call again with skip: 5/);
  assert.match(rt.readConversation(se, { limit: 2, skip: 58 }).message ?? rt.readConversation(se, { limit: 2, skip: 58 }), /message 1/);
});

test('saving the same app state again changes nothing, so it can’t start a render loop', () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'ap', title: 'A', code: '<p>x</p>', permissions: [] });
  const seq = () => store.state.seq;
  rt.appState('ap', { tab: 'one' });
  const after = seq();
  rt.appState('ap', { tab: 'one' });
  assert.equal(seq(), after, 'no event for an unchanged state');
  rt.appState('ap', { tab: 'two' });
  assert.equal(seq(), after + 1);
});

test('another agent’s show_block can’t take over an app; it gets a fresh id instead', () => {
  const { rt, store, t, b } = setup();
  const owner = rt.sessionsIn(t.id)[0];
  rt.toolsFor(owner.id).show_app({ id: 'ap', title: 'Mine', code: '<p>x</p>', permissions: [] });
  rt.appState('ap', { tab: 'one' });
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [b.id] });
  const intruder = rt.sessionsIn(other.id)[0];
  const r = rt.toolsFor(intruder.id).show_block({ block: { id: 'ap', type: 'app', version: 1, title: 'Replaced', fallback: 'x', code: '<h1>y</h1>' } });
  assert.match(r.message, /taken/);
  assert.equal(store.state.apps.ap.title, 'Mine');
  assert.equal(store.state.apps.ap.threadId, t.id);
  assert.deepEqual(store.state.apps.ap.state, { tab: 'one' });
  // The owner’s own show_block with the same id is a new version, not a reset.
  rt.toolsFor(owner.id).show_block({ block: { id: 'ap', type: 'app', version: 1, title: 'Mine', fallback: 'x', code: '<p>v2</p>' } });
  assert.equal(store.state.apps.ap.versions.length, 2);
  assert.deepEqual(store.state.apps.ap.state, { tab: 'one' });
});

test('a proposal’s fields are stored as text, whatever JSON the agent sends', () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).propose_agent({ handle: 'helper', description: { html: '<a>x</a>' }, tools: ['shell', { x: 1 }] });
  const p = store.items(t.id).find((i) => i.kind === 'proposal').proposal;
  assert.equal(typeof p.description, 'string');
  assert.deepEqual(p.tools, ['shell']);
});

test('a refusal becomes a card; the agent needs you until you answer it', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.denied({
      toolUseId: 'tu1',
      tool: 'Bash',
      input: { command: 'rm copy.txt' },
      label: 'Delete copy.txt',
      reason: 'Denied by a rule.',
      reasonType: 'rule',
      who: null,
    });
    c.denied({ toolUseId: 'tu1', tool: 'Bash', input: { command: 'rm copy.txt' }, label: 'Delete copy.txt' });
    c.text('I couldn’t delete it.');
  });
  rt.sendMessage(t.id, { text: 'clean up' });
  await settle(rt);
  const cards = store.items(t.id).filter((i) => i.kind === 'denial');
  assert.equal(cards.length, 1, 'once per tool call');
  assert.equal(cards[0].rules.once, 'Bash(rm copy.txt)');
  const se = rt.sessionsIn(t.id)[0];
  assert.equal(store.state.sessions[se.id].state, 'needs');
  assert.equal(store.state.sessions[se.id].needs.kind, 'denial');
});

test('Allow once lets the next turn run the exact call, tells the agent, and clears needs-you', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.denied({ toolUseId: 'tu1', tool: 'Bash', input: { command: 'rm copy.txt' }, label: 'Delete copy.txt' }));
  rt.sendMessage(t.id, { text: 'clean up' });
  await settle(rt);
  const card = store.items(t.id).find((i) => i.kind === 'denial');
  let seen = null;
  adapter.next.push(async (c, msg) => {
    seen = { allowOnce: c.allowOnce, text: msg.text };
  });
  await rt.act(t.id, card.id, 'once');
  await settle(rt);
  assert.deepEqual(seen.allowOnce, ['Bash(rm copy.txt)']);
  assert.match(seen.text, /next turn only/);
  assert.equal(store.item(t.id, card.id).status, 'allowed-once');
  const se = rt.sessionsIn(t.id)[0];
  assert.deepEqual(store.state.sessions[se.id].allowOnce, [], 'only that one turn');
  await assert.rejects(rt.act(t.id, card.id, 'once'), /already answered/);
});

test('Always allow saves the rule in the agent’s folder, where Claude Code reads it', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.folder = await mkdtemp(join(tmpdir(), 'pb-always-'));
  adapter.next.push(async (c) =>
    c.denied({ toolUseId: 'tu2', tool: 'WebFetch', input: { url: 'https://example.com' }, label: 'Fetched example.com', who: 'general-purpose' }),
  );
  rt.sendMessage(t.id, { text: 'look it up' });
  await settle(rt);
  const card = store.items(t.id).find((i) => i.kind === 'denial');
  await rt.act(t.id, card.id, 'always');
  await settle(rt);
  const saved = JSON.parse(await readFile(join(adapter.folder, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(saved.permissions.allow, ['WebFetch(domain:example.com)']);
  assert.match(store.items(t.id).find((i) => i.kind === 'voice').text, /Always allowed fetching pages from example\.com/);
});

test('a call you answered on a permission card never gets a refusal card too', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    const asked = c.askPermission({ tool: 'Bash', summary: 'run rm', detail: 'rm x', toolUseId: 'tu3' });
    const card = store.items(t.id).find((i) => i.kind === 'permission');
    await rt.act(t.id, card.id, 'deny');
    await asked;
    c.denied({ toolUseId: 'tu3', tool: 'Bash', input: { command: 'rm x' }, label: 'rm x' });
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'denial').length, 0);
});
