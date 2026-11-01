import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';
import { DEFAULT_MODEL as ADAPTERS_DEFAULT_MODEL } from '../server/adapters/setup.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { DEFAULT_MODEL, HOP_LIMIT, Runtime } from '../server/runtime.mjs';
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
  assert.ok(!store.items(t.id).some((i) => i.kind === 'system'), 'your mention is the record of the wake, with no line of its own (#114)');
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
  assert.deepEqual(adapter.calls.at(-1).message, {
    kind: 'event',
    event: { blockId: 'q', revision: 1, action: 'choose', values: { selected: ['a'] } },
    blockItemId: block.id,
  });
  assert.throws(() => rt.act(t.id, block.id, 'choose', { selected: ['a'] }), /already answered/);
});

test('a block you leave open stops the agent needing you once the conversation moves on (#69)', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({
      block: { id: 'r', type: 'confirm', version: 1, fallback: 'x', title: 'Rename 5 records?', statement: 'Rename them?', confirmLabel: 'Rename' },
    });
  });
  rt.sendMessage(t.id, { text: 'show me the records' });
  await settle(rt);
  const se = rt.sessionsIn(t.id)[0];
  assert.equal(store.state.sessions[se.id].needs.kind, 'block');
  // You move on without answering: a new message clears needs-you, and the turn it starts doesn’t bring it back.
  rt.sendMessage(t.id, { text: 'something else' });
  await settle(rt);
  assert.equal(store.state.sessions[se.id].needs, null);
  assert.equal(store.state.sessions[se.id].state, 'idle');
  // The block itself stays open, so you can still answer it.
  assert.equal(store.items(t.id).find((i) => i.kind === 'block').answered, false);
  // A new asking block in a later turn makes it need you again, for that block.
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: { id: 'q', type: 'confirm', version: 1, fallback: 'x', statement: 'Do it?', confirmLabel: 'Do it' } });
  });
  rt.sendMessage(t.id, { text: '@alpha ask me' });
  await settle(rt);
  const needs = store.state.sessions[se.id].needs;
  assert.equal(needs.kind, 'block');
  assert.equal(store.item(t.id, needs.itemId).block.id, 'q');
});

test('a turn you didn’t start keeps the agent needing you for the block it just asked (#69)', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: { id: 'r', type: 'confirm', version: 1, fallback: 'x', statement: 'Rename them?', confirmLabel: 'Rename' } });
  });
  rt.sendMessage(t.id, { text: 'show me the records' });
  await settle(rt);
  const se = rt.sessionsIn(t.id)[0];
  // A lint pass runs before you answer: that turn isn’t you moving on.
  rt.deliver(se.id, { kind: 'lint', undefinedTerms: [{ term: 'Step 7' }], diagrams: [] });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).message.kind, 'lint');
  assert.equal(store.state.sessions[se.id].needs?.kind, 'block');
  assert.equal(store.state.sessions[se.id].state, 'needs');
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
  // All while the chain runs: one that ends starts the count again (#492).
  for (let i = 0; i < HOP_LIMIT; i++) assert.equal(rt.agentWake(alpha.id, 'beta', 'check', { confirmed: true }).ok, true);
  const r = rt.agentWake(alpha.id, 'beta', 'check again');
  assert.equal(r.waiting, true);
  const hop = store.items(t.id).find((i) => i.kind === 'hop');
  assert.equal(hop.status, 'open');
  // One request waits at a time: a further wake is held on it, and the agent is told which card it waits for (#439).
  const again = rt.agentWake(alpha.id, 'beta', 'and again');
  assert.deepEqual([again.ok, again.waiting], [false, true]);
  assert.match(again.message, /holding your message to @beta: @alpha’s request to wake @beta/);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'hop').length, 1, 'only one request waits at a time');
  rt.act(t.id, hop.id, 'confirm');
  await settle(rt);
  assert.equal(store.item(t.id, hop.id).status, 'allowed');
});

test('a wake you allow delivers its whole message, not the card’s preview (#108)', async () => {
  const { rt, store, t, b, adapter } = setup();
  rt.ensureSession(t.id, b.id);
  const alpha = rt.sessionsIn(t.id).find((x) => x.handle === 'alpha');
  for (let i = 0; i < HOP_LIMIT; i++) rt.agentWake(alpha.id, 'beta', 'check', { confirmed: true });
  const long = `Must fix: ${'acceptance bar, '.repeat(200)}`.slice(0, 3000);
  assert.equal(rt.agentWake(alpha.id, 'beta', long).waiting, true);
  const hop = store.items(t.id).find((i) => i.kind === 'hop');
  assert.ok(hop.reason.length <= 200, 'the card keeps a short preview');
  rt.act(t.id, hop.id, 'confirm');
  await settle(rt);
  const woke = adapter.calls.filter((c) => c.handle === 'beta' && c.message.kind === 'agent' && c.message.from === '@alpha').at(-1);
  assert.equal(woke?.message.text.length, 3000);
  assert.equal(woke?.message.text, long);
});

test('a wake request stored before #108, with only a preview, still delivers that preview when allowed', async () => {
  const { rt, store, t, b, adapter } = setup();
  rt.ensureSession(t.id, b.id);
  const alpha = rt.sessionsIn(t.id).find((x) => x.handle === 'alpha');
  for (let i = 0; i < HOP_LIMIT; i++) rt.agentWake(alpha.id, 'beta', 'check', { confirmed: true });
  rt.agentWake(alpha.id, 'beta', 'the whole message');
  const hop = store.items(t.id).find((i) => i.kind === 'hop');
  rt.patchItem(t.id, hop.id, { text: undefined, reason: 'the preview' });
  rt.act(t.id, hop.id, 'confirm');
  await settle(rt);
  const woke = adapter.calls.filter((c) => c.handle === 'beta' && c.message.kind === 'agent' && c.message.from === '@alpha').at(-1);
  assert.equal(woke?.message.text, 'the preview');
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

test('#372: agents wake each other in the conversation, with no side thread or link, and a reply doesn’t go back by itself', async () => {
  const { rt, store, t, b, adapter } = setup();
  const alpha = rt.sessionsIn(t.id)[0];
  const beta = rt.ensureSession(t.id, b.id);
  adapter.next.push(async (c) => c.text('Editions are fine.'));
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await settle(rt);
  const kinds = new Set([...Object.values(store.state.threads).map((x) => x.kind), ...store.items(t.id).map((i) => i.kind)]);
  assert.ok(!kinds.has('side') && !kinds.has('sidelink'), 'no side thread, and no line for one');
  const said = store.items(t.id).filter((i) => i.kind === 'agent');
  assert.equal(said.map((i) => `@${i.handle}: ${i.text}`).join(' | '), '@alpha: Which editions? | @beta: Editions are fine.');
  // Beta’s reply doesn’t go back to alpha as a message: it’s in the conversation, and it didn’t mention @alpha.
  assert.equal(adapter.calls.map((c) => c.sessionId).join(), beta.id);
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
  // Each waits with the line Postbox wrote from what it sent, and the app’s own words apart (#51).
  assert.deepEqual(
    cards[0].events.map((e) => [e.voice, e.quote]),
    [
      ['Sent from Spam: ok · 7 bytes', 'One too many'],
      ['Sent from Spam: ok · 8 bytes', 'Later'],
    ],
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
      .map((x) => x.quote),
    ['One too many', 'Later'],
  );
  const events = adapter.calls.filter((c) => c.message.kind === 'event').slice(delivered);
  assert.ok(events.length >= 1, 'the allowed events reach the agent');
  assert.deepEqual([events[0].message.event.sent, events[0].message.event.appSummary], ['ok · 7 bytes', 'One too many']);
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
  assert.ok(!store.items(t.id).some((x) => x.kind === 'voice' && x.quote === 'Held by the browser'));
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
  await first.store.close();
  const store = await new Store(dir).load();
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  const card = store.items(first.t.id).find((x) => x.kind === 'appsend');
  assert.equal(card?.status, 'open');
  assert.equal(card.events.length, 1);
  rt.act(first.t.id, card.id, 'allow');
  await settle(rt);
  assert.ok(store.items(first.t.id).some((x) => x.kind === 'voice' && x.quote === `#${LIMIT}` && x.approved));
  assert.ok(adapter.calls.some((c) => c.message.kind === 'event' && c.message.event.blockId === 'spam'));
});

test('#51: agents read an app’s send as what Postbox counted, with the app’s summary apart from the person’s words', async () => {
  const { rt, store, t, adapter, b } = withApp();
  const other = rt.ensureSession(t.id, b.id === undefined ? rt.createPersona({ handle: 'beta' }).id : rt.createPersona({ handle: 'gamma' }).id);
  rt.appEvent('spam', 'send_pairs', { pairs: [1, 2], summary: 'Sending 1,258 pairs' }, { now: 1 });
  await settle(rt);
  const voice = store.items(t.id).find((x) => x.kind === 'voice');
  assert.equal(voice.text, 'Sent from Spam: send_pairs · pairs: 2 items · 15 bytes');
  assert.equal(voice.quote, 'Sending 1,258 pairs');
  // The app’s agent gets the event, with the facts and the app’s words as their own fields.
  const ev = adapter.calls.find((c) => c.message.kind === 'event').message.event;
  assert.deepEqual([ev.sent, ev.appSummary], ['send_pairs · pairs: 2 items · 15 bytes', 'Sending 1,258 pairs']);
  // Another agent reads the line, and the summary marked as the app’s.
  assert.match(
    rt.catchUp(store.state.sessions[other.id]),
    /You: Sent from Spam: send_pairs · pairs: 2 items · 15 bytes\nThe app’s own summary, not the person’s words: “Sending 1,258 pairs”/,
  );
});

test('#51: agents read an app’s send as what Postbox counted, with the app’s summary apart from the person’s words', async () => {
  const { rt, store, t, adapter, b } = withApp();
  const other = rt.ensureSession(t.id, b.id);
  rt.appEvent('spam', 'send_pairs', { pairs: [1, 2], summary: 'Sending 1,258 pairs' }, { now: 1 });
  await settle(rt);
  const voice = store.items(t.id).find((x) => x.kind === 'voice');
  assert.equal(voice.text, 'Sent from Spam: send_pairs · pairs: 2 items · 15 bytes');
  assert.equal(voice.quote, 'Sending 1,258 pairs');
  // The app’s agent gets the event, with the facts and the app’s words as their own fields.
  const ev = adapter.calls.find((c) => c.message.kind === 'event').message.event;
  assert.deepEqual([ev.sent, ev.appSummary], ['send_pairs · pairs: 2 items · 15 bytes', 'Sending 1,258 pairs']);
  assert.match(
    formatMessage({ kind: 'event', event: ev }),
    /What Postbox counted in it: send_pairs · pairs: 2 items · 15 bytes\nThe app’s own summary, not the person’s words: “Sending 1,258 pairs”$/,
  );
  // Another agent reads the line, and the summary marked as the app’s.
  assert.match(
    rt.catchUp(store.state.sessions[other.id]),
    /You: Sent from Spam: send_pairs · pairs: 2 items · 15 bytes\nThe app’s own summary, not the person’s words: “Sending 1,258 pairs”/,
  );
});

test('MCP: initialize, list tools, and a tool call that returns at once', async () => {
  const { rt, t, adapter } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const init = await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'postbox');
  assert.equal(await handleMcp(rt, se.id, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const tools = (await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((x) => x.name);
  assert.ok(tools.includes('show_block') && tools.includes('wake_agent'));
  const call = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'show_block', arguments: { block: { id: 'c', type: 'confirm', version: 1, fallback: 'x', statement: 'Do it?', confirmLabel: 'Do it' } } },
  };
  // A tool call comes from the running turn, with its token (#54).
  let r = null;
  adapter.next.push(async (c) => {
    r = await handleMcp(rt, se.id, call, new URL(c.mcpUrl).searchParams.get('turn'));
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
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
    const pending = handleMcp(
      rt,
      se.id,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'ls', description: 'List files' } } },
      },
      new URL(c.mcpUrl).searchParams.get('turn'),
    );
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

test('#111: sharing a topic reply keeps the question it answers', async () => {
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
  assert.deepEqual({ question: shared.question, text: shared.text }, { question: 'Offsets or pages?', text: 'Use chapter offsets.' });
  assert.match(rt.describeItem(shared), /You asked: “Offsets or pages\?” Use chapter offsets\./);
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

test('#93: after summarize back, the summary’s reply in the thread is marked sent and can’t be sent again', async () => {
  const { rt, store, t, adapter } = await conversation();
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((i) => i.kind === 'agent').id);
  adapter.next.push(async (c) => c.text('We chose offsets over pages.'));
  rt.summarizeBack(threadId);
  assert.ok(store.state.threads[threadId].summaryPending, 'pending while the turn runs');
  await settle(rt);
  const reply = store.items(threadId).find((i) => i.kind === 'agent' && i.text === 'We chose offsets over pages.');
  assert.ok(reply.sharedAt);
  assert.equal(store.state.threads[threadId].summaryPending, null);
  assert.throws(() => rt.shareToConversation(threadId, reply.id), { status: 409 });
  assert.equal(store.items(t.id).filter((i) => i.kind === 'shared').length, 1);
});

test('#93: a second summarize back while one is pending is refused, so one summary is posted', async () => {
  const { rt, store, t, adapter } = await conversation();
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((i) => i.kind === 'agent').id);
  adapter.next.push(async (c) => c.text('One summary.'));
  rt.summarizeBack(threadId);
  assert.throws(() => rt.summarizeBack(threadId), { status: 409 });
  await settle(rt);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'shared').length, 1);
  assert.equal(store.items(threadId).filter((i) => i.kind === 'voice').length, 1);
});

test('#93: a stopped summary isn’t pending, and a reply in a summary still being written can’t be sent on its own', async () => {
  const { rt, store, t, adapter } = await conversation();
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((i) => i.kind === 'agent').id);
  let release = () => {};
  adapter.next.push(async (c) => {
    c.text('Half of the summary');
    await new Promise((r) => {
      release = r;
    });
  });
  rt.summarizeBack(threadId);
  await new Promise((r) => setImmediate(r));
  const part = store.items(threadId).find((i) => i.kind === 'agent' && i.text === 'Half of the summary');
  assert.throws(() => rt.shareToConversation(threadId, part.id), { status: 409 });
  rt.stop(rt.sessionsIn(t.id)[0].id);
  release();
  await settle(rt);
  assert.equal(store.state.threads[threadId].summaryPending, null);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'shared').length, 0);
});

test('#93: a summarize turn that fails posts nothing and lets you ask again', async () => {
  const { rt, store, t, adapter } = await conversation();
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((i) => i.kind === 'agent').id);
  adapter.next.push(async () => {
    throw new Error('The model is overloaded.');
  });
  rt.summarizeBack(threadId);
  await settle(rt);
  assert.equal(store.state.threads[threadId].summaryPending, null);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'shared').length, 0);
  adapter.next.push(async (c) => c.text('Second try.'));
  rt.summarizeBack(threadId);
  await settle(rt);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'shared').length, 1);
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

test('archiving a conversation archives its sessions, its side threads’ forks too, and restore brings them all back (#101)', () => {
  const { rt, store, a, b } = setup();
  const room = rt.createThread({ projectId: 'p1', title: 'Room', personaIds: [a.id, b.id] });
  const side = rt.createThread({ projectId: 'p1', title: 'S', kind: 'side', parentId: room.id, personaIds: [a.id] });
  rt.addItem(room.id, { kind: 'user', text: 'kept' });
  const all = [...rt.sessionsIn(room.id), ...rt.sessionsIn(side.id)];
  assert.equal(all.length, 3);
  rt.archiveThread(room.id);
  for (const se of all) assert.equal(store.state.sessions[se.id].archived, true, `@${se.handle} isn’t archived`);
  assert.equal(store.state.threads[room.id].archived, true);
  assert.equal(store.state.threads[side.id].archived, true);
  // Archive keeps the transcript.
  assert.equal(store.items(room.id)[0].text, 'kept');
  assert.throws(() => rt.archiveThread(side.id), /conversation it belongs to/);
  rt.restoreThread(room.id);
  for (const se of all) assert.equal(store.state.sessions[se.id].archived, false, `@${se.handle} isn’t restored`);
  assert.equal(store.state.threads[room.id].archived, false);
  assert.equal(store.state.threads[side.id].archived, false);
});

test('a wake an archived agent scheduled doesn’t wake it, or stop the server (#101)', async () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const sc = rt.schedule(se.id, { inMs: 60000, note: 'later' });
  rt.archiveThread(t.id);
  store.emit('schedule', { ...sc, at: Date.now() }); // Due now, as at a startup after it was due, where arming reads it (#466).
  rt.arm(sc);
  await sleep(20);
  assert.equal(Object.keys(store.state.schedules).length, 0);
  assert.equal(store.items(t.id).filter((i) => i.variant === 'wake').length, 0);
});

test('archiving a conversation covers a side thread under a topic thread, and its toast’s Restore leaves an agent archived before (#101)', () => {
  const { rt, store, a, b } = setup();
  const room = rt.createThread({ projectId: 'p1', title: 'Room', personaIds: [a.id, b.id] });
  const topic = rt.createThread({ projectId: 'p1', title: 'Topic', kind: 'topic', parentId: room.id, personaIds: [a.id] });
  const side = rt.createThread({ projectId: 'p1', title: 'Side', kind: 'side', parentId: topic.id, personaIds: [b.id] });
  const before = rt.sessionsIn(room.id).find((x) => x.personaId === b.id);
  rt.archive(before.id);
  const ids = rt.archiveThread(room.id);
  const deep = rt.sessionsIn(side.id)[0];
  assert.equal(store.state.sessions[deep.id].archived, true);
  assert.equal(store.state.threads[side.id].archived, true);
  assert.ok(!ids.includes(before.id), 'it says it archived an agent that was archived already');
  assert.ok(ids.includes(deep.id));
  for (const id of ids) rt.restore(id);
  assert.equal(store.state.sessions[before.id].archived, true);
  assert.equal(store.state.sessions[deep.id].archived, false);
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
  assert.match(next.message.lint, /^\[Postbox\] Postbox checked your last reply[\s\S]*- Step 6/, 'the lint has its own place in the turn');
  assert.ok(!(next.message.context ?? []).some((c) => /checked your last reply/.test(c)), 'and isn’t background');
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
  const r = rt.toolsFor(adapter.calls.at(-1).sessionId, { threadId: topic }).define_term({ term: 'Step 2', definition: 'Quote the match instead.' });
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

test('#98: Stop leaves running progress steps stalled, starts no lint turn, and the next turn hears which', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'done' },
        { id: 'b', label: 'Read B', state: 'running' },
      ]),
    });
    await new Promise((_res, rej) => c.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  });
  rt.sendMessage(t.id, { text: 'read' });
  await sleep(10);
  rt.stop(rt.sessionsIn(t.id)[0].id);
  await settle(rt);
  await sleep(20);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.deepEqual(
    it.block.steps.map((s) => s.state),
    ['done', 'stalled'],
  );
  assert.ok(it.stalledAt);
  assert.equal(lints(adapter).length, 0, 'you stopped it: no lint turn');
  rt.sendMessage(t.id, { text: 'carry on' });
  await settle(rt);
  assert.match(
    adapter.calls.at(-1).message.context.join('\n'),
    /The person stopped your last turn while progress steps were running:\n- Block “Reading” \(id job\): Step “Read B”/,
  );
});

test('#98: a failed turn leaves running progress steps stalled too', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: progress([{ id: 'a', label: 'Read A', state: 'running' }]) });
    throw new Error('The model didn’t respond.');
  });
  rt.sendMessage(t.id, { text: 'read' });
  await settle(rt);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.equal(it.block.steps[0].state, 'stalled');
  assert.ok(it.stalledAt);
  assert.match(store.state.sessions[rt.sessionsIn(t.id)[0].id].context.join('\n'), /Your last turn failed while progress steps were running/);
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

test('#75: a conversation started without a title is a “New conversation”, and agents are told what they define where', () => {
  const { rt, store, t } = setup();
  assert.equal(rt.createThread({ projectId: 'p1' }).title, 'New conversation');
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  assert.equal(tools.define_term({ term: 'BM25', definition: 'A ranking function.' }).message, 'Defined “BM25”.');
  // A topic thread’s definition over its conversation’s says “here”, not “this thread”.
  rt.putThread({ ...store.state.threads[t.id], id: 'th-topic', kind: 'topic', parentId: t.id, members: [] });
  const se = rt.ensureSession('th-topic', rt.sessionsIn(t.id)[0].personaId);
  assert.equal(
    rt.toolsFor(se.id).define_term({ term: 'BM25', definition: 'Here, the baseline.' }).message,
    'Defined “BM25” here, over the conversation’s definition.',
  );
});

test('#94: an outcome on an answered confirm reports the result: it stays answered and nobody is asked again', async () => {
  const { rt, store, t, adapter } = setup();
  const confirm = {
    id: 'frames',
    type: 'confirm',
    version: 1,
    fallback: 'Delete?',
    title: 'Delete the video frames?',
    statement: 'Delete 23 frames?',
    confirmLabel: 'Delete',
  };
  adapter.next.push(async (c) => c.tools.show_block({ block: confirm }));
  rt.sendMessage(t.id, { text: 'clean up' });
  await settle(rt);
  const se = rt.sessionsIn(t.id)[0];
  const item = store.items(t.id).find((i) => i.kind === 'block');
  rt.act(t.id, item.id, 'confirm', {});
  // As in the UAT that found it: the agent reports back on the same block, retitled, with an “OK” button.
  let said;
  adapter.next.push(async (c) => {
    said = c.tools.update_block({
      block: { ...confirm, title: 'Video frames deleted', confirmLabel: 'OK', outcome: 'Done: 23 frames deleted' },
    });
    c.text('Deleted them.');
  });
  await settle(rt);
  const it = store.item(t.id, item.id);
  assert.equal(it.answered, true);
  assert.equal(it.answer.action, 'confirm');
  assert.equal(it.block.outcome, 'Done: 23 frames deleted');
  // The question the person answered stays as they saw it, and the agent is told its other changes didn’t apply.
  assert.equal(it.block.title, 'Delete the video frames?');
  assert.equal(it.block.confirmLabel, 'Delete');
  assert.equal(it.turnId, item.turnId);
  assert.equal(said.ok, true);
  assert.match(said.message, /stays answered\. Your other changes \(title, confirmLabel\) weren’t applied/);
  assert.equal(store.state.sessions[se.id].needs, null);
  assert.equal(store.state.sessions[se.id].state, 'idle');
  assert.throws(() => rt.act(t.id, item.id, 'confirm', {}), /already answered/);

  // An update without outcome asks again, as before.
  adapter.next.push(async (c) => c.tools.update_block({ block: { ...confirm, statement: 'Delete 4 more?' } }));
  rt.sendMessage(t.id, { text: 'more?' });
  await settle(rt);
  assert.equal(store.item(t.id, item.id).answered, false);
  assert.equal(store.item(t.id, item.id).block.outcome, undefined);
  assert.equal(store.state.sessions[se.id].needs?.kind, 'block');
});

test('#94: an outcome on a block nobody answered yet is refused, and the block is left alone', () => {
  const { rt, store, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const tools = rt.toolsFor(se.id);
  const choice = { id: 'c', type: 'choice', version: 1, fallback: 'Pick', options: [{ id: 'a', label: 'A' }] };
  tools.show_block({ block: choice });
  const r = tools.update_block({ block: { ...choice, outcome: 'Done.' } });
  assert.equal(r.ok, false);
  assert.match(r.message, /hasn’t been answered yet/);
  assert.equal(store.items(t.id).find((i) => i.kind === 'block').block.outcome, undefined);
  // An outcome with nothing else changed gets no note about other changes.
  rt.act(t.id, store.items(t.id).find((i) => i.kind === 'block').id, 'choose', { selected: ['a'] });
  assert.equal(
    tools.update_block({ block: { ...choice, outcome: 'Done.' } }).message,
    'Recorded the outcome under the person’s answer to c; it stays answered.',
  );
  // Reopened by an update without outcome, it’s unanswered again, so an outcome is refused again.
  tools.update_block({ block: { ...choice, prompt: 'Pick again?' } });
  const again = tools.update_block({ block: { ...choice, prompt: 'Pick again?', outcome: 'Done.' } });
  assert.equal(again.ok, false);
  assert.match(again.message, /^The update wasn’t applied\. .*set outcome with update_block once they’ve answered/);
  assert.equal(store.items(t.id).find((i) => i.kind === 'block').block.outcome, undefined);
});

test('#94: show_block refuses an outcome, so a result can’t show under an answer it didn’t come from', () => {
  const { rt, store, t } = setup();
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  // The review’s scenario: an outcome sent with the question would show under Cancel too.
  const confirm = { id: 'frames', type: 'confirm', version: 1, fallback: 'Delete?', statement: 'Delete 23 frames?', confirmLabel: 'Delete' };
  const r = tools.show_block({ block: { ...confirm, outcome: 'Deleted 23 frames' } });
  assert.equal(r.ok, false);
  assert.match(r.message, /^The block wasn’t shown\. outcome reports the result of the person’s answer, and frames hasn’t been answered yet\./);
  assert.match(r.message, /set outcome with update_block once they’ve answered/);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'block').length, 0);
  // Without it, the block shows, and a Cancel gets no outcome.
  assert.equal(tools.show_block({ block: confirm }).ok, true);
  const item = store.items(t.id).find((i) => i.kind === 'block');
  rt.act(t.id, item.id, 'cancel', {});
  assert.equal(store.item(t.id, item.id).block.outcome, undefined);
});

test('#125: show_block refuses an id this session already shows here, open or answered, so an answer belongs to one block', () => {
  const { rt, store, t, b } = setup();
  const se = rt.sessionsIn(t.id)[0];
  const tools = rt.toolsFor(se.id);
  const review = (title, content) => ({ id: 'issue-review', type: 'review', version: 1, fallback: 'Draft', title, format: 'markdown', content });
  const blocks = () => store.items(t.id).filter((i) => i.kind === 'block');
  assert.equal(tools.show_block({ block: review('Draft A', 'A') }).ok, true);
  // The UAT’s case: a second, different draft under the same id, 27 seconds later.
  const again = tools.show_block({ block: review('Draft B', 'B') });
  assert.equal(again.ok, false);
  assert.equal(again.message, 'Block issue-review is already shown. Use update_block to change it, or pick a new id.');
  assert.equal(blocks().length, 1);
  assert.equal(blocks()[0].block.title, 'Draft A');
  // Answered, it still holds the id: an outcome or an update by that id can only mean it.
  rt.act(t.id, blocks()[0].id, 'submit', { verdict: 'approve', comments: [] });
  assert.equal(tools.show_block({ block: review('Draft B', 'B') }).ok, false);
  assert.equal(blocks().length, 1);
  // A new id is a new block, and another agent’s block may use the same id: each answers to its own session.
  assert.equal(tools.show_block({ block: { ...review('Draft B', 'B'), id: 'issue-review-2' } }).ok, true);
  const other = rt.ensureSession(t.id, b.id);
  assert.equal(rt.toolsFor(other.id).show_block({ block: review('Theirs', 'C') }).ok, true);
  assert.equal(blocks().length, 3);
});

/** A review block, and a turn the test holds open until it calls release(); started() resolves once it’s held. */
function reviewSetup() {
  const s = setup();
  const review = (content, extra = {}) => ({ id: 'issue', type: 'review', version: 1, fallback: 'Draft', format: 'markdown', content, ...extra });
  let release = () => {};
  let isHeld = () => {};
  const holding = new Promise((r) => {
    isHeld = r;
  });
  const held = () =>
    new Promise((r) => {
      release = r;
      isHeld();
    });
  return { ...s, review, held, started: () => holding, release: () => release() };
}

test('#123: update_block won’t reopen a block over an answer the agent hasn’t read; the reply says what it was', async () => {
  const { rt, store, t, adapter, review, held, started, release } = reviewSetup();
  adapter.next.push(async (c) => c.tools.show_block({ block: review('v1') }));
  rt.sendMessage(t.id, { text: 'draft it' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'block');
  // The UAT’s order: the agent is working on revision 2 when the person answers it, and then it updates again.
  let refused;
  adapter.next.push(async (c) => {
    c.tools.update_block({ block: review('v2') });
    await held();
    refused = c.tools.update_block({ block: review('v3') });
  });
  rt.sendMessage(t.id, { text: 'revise it' });
  await started();
  rt.act(
    t.id,
    item.id,
    'submit',
    {
      verdict: 'request_changes',
      comments: [
        { line: 1, text: 'a' },
        { line: 1, text: 'b' },
        { line: 1, text: 'c' },
      ],
    },
    2,
  );
  // The answer waits in the agent’s queue while it works.
  assert.equal(store.item(t.id, item.id).answer.read, false);
  release();
  await settle(rt);
  assert.equal(refused.ok, false);
  const at = new Date(store.item(t.id, item.id).answer.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  assert.equal(
    refused.message,
    `The update wasn’t applied. The person answered revision 2 of issue at ${at}: request_changes, 3 comments. Their answer stays on screen. It reaches you when this turn ends: read it, then update.`,
  );
  // Nothing changed for the person: their answer, the revision they answered, and the text.
  const it = store.item(t.id, item.id);
  assert.equal(it.answered, true);
  assert.equal(it.revision, 2);
  assert.equal(it.block.content, 'v2');
  // When the turn ended, the answer reached the agent, naming revision 2; now it has read it, so an update applies.
  const event = adapter.calls.at(-1).message;
  assert.equal(event.kind, 'event');
  assert.equal(event.event.revision, 2);
  assert.equal(it.answer.read, true);
  adapter.next.push(async (c) => {
    refused = c.tools.update_block({ block: review('v3', { previous: 'v2' }) });
  });
  rt.sendMessage(t.id, { text: 'go on' });
  await settle(rt);
  assert.equal(refused.ok, true);
  assert.equal(store.item(t.id, item.id).answered, false);
  assert.equal(store.item(t.id, item.id).revision, 3);
});

test('#123: an outcome over an answer the agent hasn’t read is refused, and a dropped answer comes in the reply', async () => {
  const { rt, store, t, adapter, held, started, release } = reviewSetup();
  const confirm = { id: 'frames', type: 'confirm', version: 1, fallback: 'Delete?', statement: 'Delete 23 frames?', confirmLabel: 'Delete' };
  adapter.next.push(async (c) => c.tools.show_block({ block: confirm }));
  rt.sendMessage(t.id, { text: 'clean up' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'block');
  const se = rt.sessionsIn(t.id)[0];
  const replies = [];
  adapter.next.push(async (c) => {
    await held();
    replies.push(c.tools.update_block({ block: { ...confirm, outcome: 'Deleted.' } }));
  });
  rt.sendMessage(t.id, { text: 'busy' });
  await started();
  // The person presses Cancel while the agent works; not having read that, it reports the frames deleted.
  rt.act(t.id, item.id, 'cancel', {}, 1);
  release();
  await settle(rt);
  assert.equal(replies[0].ok, false);
  const at = new Date(store.item(t.id, item.id).answer.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  assert.equal(
    replies[0].message,
    `The outcome wasn’t recorded: you haven’t read the answer it reports on. The person answered revision 1 of frames at ${at}: cancel {}. Their answer stays on screen. It reaches you when this turn ends: read it, then record the outcome.`,
  );
  assert.equal(store.item(t.id, item.id).block.outcome, undefined);
  assert.equal(store.item(t.id, item.id).answered, true);
  // Once it has read the Cancel, its outcome records (#94).
  adapter.next.push(async (c) => replies.push(c.tools.update_block({ block: { ...confirm, outcome: 'Kept them.' } })));
  rt.sendMessage(t.id, { text: 'and?' });
  await settle(rt);
  assert.equal(replies[1].ok, true);
  assert.equal(store.item(t.id, item.id).block.outcome, 'Kept them.');

  // Stop drops what waited behind the turn, so the answer never reaches the agent: the refusal carries all of it.
  rt.patchItem(t.id, item.id, { answered: false, answer: null });
  let working = () => {};
  const isWorking = new Promise((r) => {
    working = r;
  });
  adapter.next.push(async (c) => {
    c.text('working');
    working();
    await new Promise((_res, rej) => c.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  });
  rt.sendMessage(t.id, { text: 'go' });
  await isWorking;
  rt.act(t.id, item.id, 'cancel', {}, store.item(t.id, item.id).revision ?? 1);
  rt.stop(se.id);
  await settle(rt);
  assert.equal(store.item(t.id, item.id).answer.read, false);
  const tools = rt.toolsFor(se.id);
  const r = tools.update_block({ block: { ...confirm, statement: 'Delete 4 more?' } });
  assert.equal(r.ok, false);
  assert.match(r.message, /^The update wasn’t applied\. The person answered revision 1 of frames at \d\d:\d\d: cancel \{\}\. Their answer stays on screen\./);
  assert.match(r.message, /It didn’t reach you in a turn, so that’s the whole answer\. Read it, then update\.$/);
  assert.equal(store.item(t.id, item.id).answered, true);
  // Having read it in that reply, the agent can ask again.
  assert.equal(tools.update_block({ block: { ...confirm, statement: 'Delete 4 more?' } }).ok, true);
  assert.equal(store.item(t.id, item.id).answered, false);
});

test('#123: an answer to a revision the agent has since replaced is refused, and nothing reaches the agent', async () => {
  const { rt, store, t, adapter, review } = reviewSetup();
  adapter.next.push(async (c) => c.tools.show_block({ block: review('v1') }));
  rt.sendMessage(t.id, { text: 'draft it' });
  await settle(rt);
  const item = store.items(t.id).find((i) => i.kind === 'block');
  adapter.next.push(async (c) => c.tools.update_block({ block: review('v2', { previous: 'v1' }) }));
  rt.sendMessage(t.id, { text: 'revise it' });
  await settle(rt);
  const calls = adapter.calls.length;
  // The person approves the text they saw, revision 1; the agent has replaced it with revision 2.
  assert.throws(
    () => rt.act(t.id, item.id, 'submit', { verdict: 'approve', comments: [] }, 1),
    (e) =>
      e.status === 409 &&
      e.code === 'stale' &&
      e.message === 'This changed while you were answering: you answered revision 1, and it’s now revision 2. Look it over, then answer again.',
  );
  assert.equal(store.item(t.id, item.id).answered, false);
  assert.ok(!store.items(t.id).some((i) => i.kind === 'voice'));
  await settle(rt);
  assert.equal(adapter.calls.length, calls);
  // A revision that isn’t a whole number is a bad request.
  assert.throws(
    () => rt.act(t.id, item.id, 'submit', { verdict: 'approve', comments: [] }, '2'),
    (e) => e.status === 422,
  );
  // Answering the revision on screen goes through, and the event names it.
  rt.act(t.id, item.id, 'submit', { verdict: 'approve', comments: [] }, 2);
  await settle(rt);
  assert.equal(adapter.calls.at(-1).message.event.revision, 2);
  assert.equal(store.item(t.id, item.id).answer.revision, 2);
});

test('#125: an app id the session owns still makes a new version, and an invalid block can be sent again', () => {
  const { rt, store, t } = setup();
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  assert.equal(tools.show_app({ id: 'ap', title: 'A', code: '<p>1</p>' }).ok, true);
  assert.equal(tools.show_app({ id: 'ap', title: 'A', code: '<p>2</p>' }).ok, true);
  assert.equal(store.state.apps.ap.versions.length, 2);
  // A block can’t take an app’s id: an update by it couldn’t reach the block, so it asks for a new id instead.
  const taken = tools.show_block({ block: { id: 'ap', type: 'confirm', version: 1, fallback: 'x', statement: 'Go?', confirmLabel: 'Go' } });
  assert.equal(taken.ok, false);
  assert.equal(taken.message, 'ap is the id of your app “A”. Pick a new id for this block.');
  // An invalid block shows only its fallback and can’t be answered, so its fixed copy may use the same id.
  const bad = { id: 'q', type: 'choice', version: 1, fallback: 'Pick', options: [] };
  assert.equal(tools.show_block({ block: bad }).ok, false);
  assert.equal(tools.show_block({ block: { ...bad, options: [{ id: 'a', label: 'A' }] } }).ok, true);
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
  assert.match(ctx, /the last 40; 20 earlier items are left out: 20 messages from the person, and read_conversation with skip: 40 has them/);
  assert.ok(ctx.includes('message 59') && !ctx.includes('message 19\n'));
  const r = rt.toolsFor(se.id).read_conversation({ limit: 5, skip: 0 });
  assert.match(r.message, /You: message 59/);
  assert.match(r.message, /call again with skip: 5/);
  assert.match(rt.readConversation(se, { limit: 2, skip: 58 }).message ?? rt.readConversation(se, { limit: 2, skip: 58 }), /message 1/);
});

/** A reply of about 5,000 characters, as @critic's were in the research UAT (#109), with a last paragraph to quote. */
const LONG_REPLY = `${Array.from({ length: 24 }, (_, i) => `Finding ${i + 1}: the claim in section ${i + 1} rests on one study, and its sample is small. `.repeat(3)).join('\n\n')}\n\nLast, the conclusion holds only for adults over 60.`;

/** @alpha writes LONG_REPLY, then the person asks @beta to review it. Returns @beta’s session and its catch-up. */
async function longReplyReviewed() {
  const ctx = setup();
  const { rt, store, t, adapter } = ctx;
  adapter.next.push(async (c) => c.text(LONG_REPLY));
  rt.sendMessage(t.id, { text: 'Write up the findings' });
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta review what alpha wrote' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha');
  const call = adapter.calls.at(-1);
  return { ...ctx, reply, se: rt.s.sessions[call.sessionId], catchUp: (call.message.context ?? []).join('\n') };
}

test('#109 history cuts a long reply, says how much it kept, and gives the id read_message takes', async () => {
  const { reply, catchUp } = await longReplyReviewed();
  assert.ok(LONG_REPLY.length > 5000);
  const total = LONG_REPLY.length.toLocaleString('en-US');
  assert.ok(catchUp.includes(`@alpha: ${LONG_REPLY.slice(0, 2000)}… (2,000 of ${total} characters; read_message { id: "${reply.id}" } has the rest)`));
  assert.doesNotMatch(catchUp, /adults over 60/);
});

test('#109 read_message gives the reviewer the whole reply, so it can quote the last paragraph', async () => {
  const { rt, reply, se } = await longReplyReviewed();
  const r = rt.toolsFor(se.id).read_message({ id: reply.id });
  assert.equal(r.ok, true);
  assert.equal(r.message, `@alpha: ${LONG_REPLY}`);
  assert.match(r.message, /Last, the conclusion holds only for adults over 60\.$/);
});

test('#109 read_conversation cuts the same way, the agent’s own messages too, and stays as it was otherwise', async () => {
  const { rt, t, a, reply, se } = await longReplyReviewed();
  const total = LONG_REPLY.length.toLocaleString('en-US');
  const theirs = rt.toolsFor(se.id).read_conversation({}).message;
  assert.match(theirs, new RegExp(`^\\[it_\\w+\\] You: Write up the findings\\n\\n\\[${reply.id}\\] @alpha: Finding 1`));
  assert.match(theirs, new RegExp(`2,000 of ${total} characters; read_message \\{ id: "${reply.id}" \\} has the rest\\)\\n\\n\\[it_\\w+\\] You: @beta review`));
  const alpha = rt.sessionsIn(t.id).find((x) => x.personaId === a.id);
  assert.ok(
    rt
      .toolsFor(alpha.id)
      .read_conversation({})
      .message.includes(`You (@alpha): ${LONG_REPLY.slice(0, 2000)}… (2,000 of ${total}`),
  );
  // A short item is whole: its id is in front, and nothing says it was cut.
  assert.doesNotMatch(theirs, /review what alpha wrote… \(/);
});

test('#109 read_message reads a long item in parts, and says where it couldn’t find one', async () => {
  const { rt, store, t, se } = await longReplyReviewed();
  const huge = 'x'.repeat(95_000);
  const it = rt.addItem(t.id, { kind: 'agent', handle: 'alpha', sessionId: 'other', text: huge, status: 'done' });
  const read = rt.toolsFor(se.id).read_message;
  const one = read({ id: it.id });
  assert.equal(one.ok, true);
  assert.ok(one.message.startsWith(`@alpha: ${'x'.repeat(39_992)}\n\n`));
  assert.match(one.message, new RegExp(`\\(Characters 1–40,000 of 95,008\\. read_message \\{ id: "${it.id}", from: 40000 \\} reads on\\.\\)$`));
  const last = read({ id: it.id, from: 80_000 });
  assert.match(last.message, /\(Characters 80,001–95,008 of 95,008\.\)$/);
  assert.equal(last.message.split('\n\n')[0].length, 15_008);
  // At or past the end, it says so rather than giving an empty part.
  for (const from of [95_008, 120_000]) {
    const after = read({ id: it.id, from });
    assert.equal(after.ok, true);
    assert.equal(after.message, `Nothing after character 95,008: that’s the end of ${it.id}.`);
  }
  const missing = read({ id: 'it_nope' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /There’s no item “it_nope” in this conversation/);
  assert.equal(read({}).ok, false);
  assert.ok(store.items(t.id).includes(it));
});

test('#109 read_message is in the MCP tool list and answers over MCP', async () => {
  const { rt, reply, se } = await longReplyReviewed();
  const tools = (await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const def = tools.find((x) => x.name === 'read_message');
  assert.deepEqual(def?.inputSchema.required, ['id']);
  assert.match(def.description, /2,000 characters/);
  assert.match(def.description, /a block’s whole content with its comments and the person’s answer/);
  assert.match(tools.find((x) => x.name === 'read_conversation').description, /its id, .*read_message and react take, and is cut at 2,000/);
  // A tool call comes from the agent's running turn, with its token (#54).
  rt.turns.set(se.id, { id: 'tu_read', token: 'tok', sessionId: se.id, threadId: se.threadId, segment: null });
  const r = await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_message', arguments: { id: reply.id } } }, 'tok');
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0].text, /adults over 60\.$/);
  const bad = await handleMcp(
    rt,
    se.id,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_message', arguments: { id: 'it_nope' } } },
    'tok',
  );
  assert.equal(bad.result.isError, true);
  rt.turns.delete(se.id);
});

test('#109 a topic thread’s root, cut at 4,000, gives its id, and read_message reads it from the thread', async () => {
  const { rt, store, t, adapter, reply } = await longReplyReviewed();
  rt.createPersona({ handle: 'critic' });
  const { threadId } = rt.startTopic(t.id, reply.id);
  rt.sendMessage(threadId, { text: '@critic is the last point right?' });
  await settle(rt);
  const call = adapter.calls.at(-1);
  assert.equal(call.handle, 'critic');
  const context = [call.message.taskContext, ...(call.message.context ?? [])].filter(Boolean).join('\n');
  assert.match(
    context,
    new RegExp(
      `This thread started from @alpha’s message: Finding 1[^]*… \\(4,000 of [\\d,]+ characters; read_message \\{ id: "${reply.id}" \\} has the rest\\)`,
    ),
  );
  assert.match(rt.toolsFor(call.sessionId).read_message({ id: reply.id }).message, /adults over 60\.$/);
  assert.ok(store.items(threadId).length >= 1);
});

/** The plan @researcher showed in the Gemini room UAT (#153), as a review block. */
const PLAN =
  '# Dedup plan\n\n1. Hash each passage’s normalized text.\n2. Keep the earliest edition of each hash.\n\nRisk: two editions with different page breaks hash apart.';

/** @alpha shows `blocks` in one turn and the person answers some; then @beta is asked about them. */
async function blocksShown(blocks, answers = []) {
  const ctx = setup();
  const { rt, store, t, adapter } = ctx;
  adapter.next.push(async (c) => {
    for (const b of blocks) assert.equal(c.tools.show_block({ block: { version: 1, ...b } }).ok, true, b.id);
  });
  rt.sendMessage(t.id, { text: 'Show me' });
  await settle(rt);
  const item = (id) => store.items(t.id).find((i) => i.kind === 'block' && i.block.id === id);
  for (const [id, action, values] of answers) rt.act(t.id, item(id).id, action, values);
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta what do you make of these?' });
  await settle(rt);
  const call = adapter.calls.at(-1);
  assert.equal(call.handle, 'beta');
  return { ...ctx, item, se: rt.s.sessions[call.sessionId], catchUp: (call.message.context ?? []).join('\n') };
}

test('#153 another agent reads a review block’s draft in its history, not only its title', async () => {
  const { rt, se, catchUp } = await blocksShown([
    { id: 'dedup-plan', type: 'review', title: 'Dedup plan', format: 'markdown', content: PLAN, fallback: 'The dedup plan.' },
  ]);
  assert.ok(catchUp.includes(`@alpha showed a review block “Dedup plan”:\n${PLAN}`), catchUp);
  assert.ok(rt.toolsFor(se.id).read_conversation({}).message.includes(`@alpha showed a review block “Dedup plan”:\n${PLAN}`));
});

test('#153 a choice and a form give their prompt, options or fields, and the person’s answer', async () => {
  const { catchUp } = await blocksShown(
    [
      {
        id: 'when',
        type: 'choice',
        title: 'When',
        prompt: 'When should the digest go out?',
        options: [
          { id: 'mon', label: 'Monday 9:00' },
          { id: 'fri', label: 'Friday 16:00' },
        ],
        fallback: 'Monday or Friday?',
      },
      {
        id: 'brief',
        type: 'form',
        title: 'Brief',
        prompt: 'Two questions before I start.',
        fields: [
          { id: 'reader', label: 'Who will read it?', kind: 'text', required: true },
          {
            id: 'tone',
            label: 'Tone',
            kind: 'select',
            options: [
              { id: 'plain', label: 'Plain' },
              { id: 'warm', label: 'Warm' },
            ],
          },
          { id: 'notes', label: 'Anything else?', kind: 'longtext' },
        ],
        fallback: 'Who will read it, and in what tone?',
      },
    ],
    [
      ['when', 'choose', { selected: ['fri'] }],
      ['brief', 'submit', { reader: 'The board', tone: 'warm', notes: 'Keep it under a page.' }],
    ],
  );
  assert.ok(
    catchUp.includes(
      '@alpha showed a choice block “When”:\nWhen should the digest go out?\n\nOptions: Monday 9:00 · Friday 16:00\n\nThe person answered: Friday 16:00',
    ),
    catchUp,
  );
  assert.ok(
    catchUp.includes(
      '@alpha showed a form block “Brief”:\nTwo questions before I start.\n\nFields:\n- Who will read it? (text, required)\n- Tone (select): Plain · Warm\n- Anything else? (longtext)\n\nThe person answered:\n- Who will read it?: The board\n- Tone: Warm\n- Anything else?: Keep it under a page.',
    ),
    catchUp,
  );
});

test('#153 a card and a code block give their content; an app only its title; a table its fallback', async () => {
  const { catchUp } = await blocksShown([
    {
      id: 'c',
      type: 'card',
      title: 'Corpus',
      body: 'Loaded **12** books.',
      facts: [{ label: 'Passages', value: '4,210' }],
      actions: [{ id: 'go', label: 'Index it' }],
      fallback: 'Loaded 12 books.',
    },
    { id: 'k', type: 'code', title: 'Chunker', code: 'const fence = "```";', language: 'js', filename: 'chunk.js', fallback: 'The chunker.' },
    {
      id: 'r',
      type: 'table',
      title: 'Results',
      columns: [{ id: 'c', label: 'Claim' }],
      rows: [{ id: 'r1', cells: { c: '12' } }],
      fallback: 'Claim 12 | supported',
    },
  ]);
  assert.ok(catchUp.includes('@alpha showed a card block “Corpus”:\nLoaded **12** books.\n\n- Passages: 4,210\n\nButtons: Index it'), catchUp);
  assert.ok(catchUp.includes('@alpha showed a code block “Chunker”:\nchunk.js:\n````js\nconst fence = "```";\n````'), catchUp);
  assert.ok(catchUp.includes('@alpha showed a table block “Results”: Claim 12 | supported'), catchUp);
});

test('#153 an app is still its title alone', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.tools.show_app({ id: 'explorer', title: 'Explorer', code: '<main>Secret code</main>' }));
  rt.sendMessage(t.id, { text: 'Build it' });
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta look' });
  await settle(rt);
  const ctx = adapter.calls.at(-1).message.context.join('\n');
  assert.match(ctx, /@alpha showed an app “Explorer”(\n|$)/);
  assert.doesNotMatch(ctx, /Secret code/);
  assert.ok(store.items(t.id).some((i) => i.kind === 'block'));
});

test('#153 a long draft is cut with its id, and read_message gives the whole block, comments and review', async () => {
  const draft = `${'A paragraph of the design note, with its reasons. '.repeat(60)}\n\nLast: ship the dedup behind a flag.`;
  const { rt, se, item, catchUp } = await blocksShown(
    [
      {
        id: 'note',
        type: 'review',
        title: 'Design note',
        format: 'markdown',
        content: draft,
        threads: [{ id: 'th1', line: 1, status: 'open', comments: [{ author: '@critic', text: 'Which flag?' }] }],
        fallback: 'The design note.',
      },
    ],
    [['note', 'submit', { verdict: 'request_changes', comments: [{ line: 3, text: 'Name the flag.' }] }]],
  );
  const it = item('note');
  assert.match(
    catchUp,
    new RegExp(
      `@alpha showed a review block “Design note”:\\nA paragraph[^]*… \\(2,000 of [\\d,]+ characters; read_message \\{ id: "${it.id}" \\} has the rest\\)`,
    ),
  );
  assert.doesNotMatch(catchUp, /ship the dedup/);
  for (const id of [it.id, 'note']) {
    const r = rt.toolsFor(se.id).read_message({ id });
    assert.equal(r.ok, true, id);
    assert.ok(
      r.message.includes(
        `${draft}\n\nComments on line 1 (open):\n- @critic: Which flag?\n\nThe person’s review: Request changes · 1 comment\n- line 3: Name the flag.`,
      ),
      r.message,
    );
  }
});

test('#153 an agent reads its own review block’s content in read_conversation', async () => {
  const { rt, t, a } = await blocksShown([{ id: 'dedup-plan', type: 'review', title: 'Dedup plan', format: 'markdown', content: PLAN, fallback: 'The plan.' }]);
  const alpha = rt.sessionsIn(t.id).find((x) => x.personaId === a.id);
  assert.ok(rt.toolsFor(alpha.id).read_conversation({}).message.includes(`@alpha showed a review block “Dedup plan”:\n${PLAN}`));
});

test('#153 read_message by a block id two agents both used asks for the item id', async () => {
  const { rt, t, se, item } = await blocksShown([{ id: 'plan', type: 'code', code: 'a', fallback: 'a' }]);
  rt.addItem(t.id, {
    kind: 'block',
    sessionId: se.id,
    handle: 'beta',
    valid: true,
    block: { id: 'plan', type: 'code', version: 1, code: 'b', fallback: 'b' },
    answered: false,
  });
  const r = rt.toolsFor(se.id).read_message({ id: 'plan' });
  assert.equal(r.ok, false);
  assert.match(r.message, new RegExp(`More than one block is called “plan”: @alpha’s is ${item('plan').id}, @beta’s is it_`));
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

// ── #59: your MCP servers ─────────────────────────────────────────────────────────────────

test('#59: a persona keeps the MCP servers it turned off, checked, and they follow it from the next turn', async () => {
  const { rt, t, a, adapter } = setup();
  assert.deepEqual(rt.createPersona({ handle: 'coder' }).mcpOff, [], 'all on by default');
  assert.deepEqual(rt.updatePersona(a.id, { mcpOff: [' search ', 'search', 'postbox', 'claude.ai Gmail'] }).mcpOff, ['search', 'claude.ai Gmail']);
  for (const bad of ['search', [1], [''], ['x'.repeat(201)], Array.from({ length: 101 }, (_, i) => `s${i}`), null]) {
    assert.throws(
      () => rt.updatePersona(a.id, { mcpOff: bad }),
      (e) => e.status === 422 && /MCP servers turned off/.test(e.message),
    );
    assert.throws(
      () => rt.createPersona({ handle: 'nope', mcpOff: bad }),
      (e) => e.status === 422,
    );
  }
  const seen = [];
  adapter.next.push(async (c) => seen.push(c.persona.mcpOff));
  adapter.next.push(async (c) => seen.push(c.persona.mcpOff));
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  rt.updatePersona(a.id, { mcpOff: [] });
  rt.sendMessage(t.id, { text: 'two' });
  await settle(rt);
  assert.deepEqual(seen, [['search', 'claude.ai Gmail'], []]);
});

test('#59: the MCP servers a turn reports are kept on its session, bounded, for the sheet’s status', async () => {
  const { rt, t, a, adapter, store } = setup();
  const many = Array.from({ length: 120 }, (_, i) => ({ name: `s${i}`, status: 'connected', source: 'user', config: { secret: 'x' } }));
  adapter.next.push(async (c) => c.reported({ mcpServers: [{ name: 'search', status: 'needs-auth', source: 'claudeai' }, { status: 'x' }, ...many] }));
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  const se = rt.sessionsIn(t.id)[0];
  const kept = store.state.sessions[se.id].mcpServers;
  assert.equal(typeof kept.at, 'number');
  assert.equal(kept.servers.length, 100);
  assert.deepEqual(kept.servers[0], { name: 'search', status: 'needs-auth', source: 'claudeai' });
  assert.ok(!JSON.stringify(kept).includes('secret'), 'never a server’s config');
  // The sheet reads the latest, from this persona’s sessions, in the folder of its latest conversation.
  const ctx = rt.mcpContext(a.id, null);
  assert.equal(ctx.folder, '/tmp');
  assert.equal(ctx.seen[0].name, 'search');
  assert.equal(rt.mcpContext(null, 'p1').folder, '/tmp');
  assert.deepEqual(rt.mcpContext(null, null), { persona: null, folder: null, seen: [] }, 'mock sessions don’t lend their servers to a new agent');
});

test('#59: a sheet that reads an init from another folder shows only the servers that load everywhere', async () => {
  const { rt, t, a, adapter, store } = setup();
  const servers = [
    { name: 'docs', status: 'connected', source: 'project' },
    { name: 'notes', status: 'connected', source: 'local' },
    { name: 'search', status: 'connected', source: 'user' },
    { name: 'Gmail', status: 'needs-auth', source: 'claudeai' },
  ];
  adapter.next.push(async (c) => c.reported({ mcpServers: servers }));
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  // The same folder: everything that init saw.
  assert.deepEqual(
    rt.mcpContext(a.id, 'p1').seen.map((s) => s.name),
    ['docs', 'notes', 'search', 'Gmail'],
  );
  // Another folder: its project and local servers aren’t known there.
  store.emit('project', { id: 'p2', name: 'Q', folder: '/elsewhere' });
  assert.deepEqual(
    rt.mcpContext(a.id, 'p2').seen.map((s) => s.name),
    ['search', 'Gmail'],
  );
});

test('#5: a persona’s tools, which real backends deny when unticked, follow it from the next turn', async () => {
  const { rt, t, a, adapter } = setup();
  const seen = [];
  adapter.next.push(async (c) => seen.push(c.persona.tools));
  adapter.next.push(async (c) => seen.push(c.persona.tools));
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  rt.updatePersona(a.id, { tools: ['corpus.search', 'shell'] });
  rt.sendMessage(t.id, { text: 'two' });
  await settle(rt);
  assert.deepEqual(seen, [['corpus.search'], ['corpus.search', 'shell']]);
});

// ── #60: model and effort ────────────────────────────────────────────────────────────────

test('#60: a persona has an effort next to its model, checked, fixed in a session’s snapshot like the model', async () => {
  const { rt, t, a, adapter, store } = setup();
  assert.equal(rt.createPersona({ handle: 'coder' }).effort, 'medium', 'Claude Code’s own default for Opus 5.5');
  assert.equal(DEFAULT_MODEL, ADAPTERS_DEFAULT_MODEL, 'the runtime and the adapters default to the same model');
  assert.equal(rt.createPersona({ handle: 'deep', effort: 'xhigh' }).effort, 'xhigh');
  for (const bad of ['ultra', '', null, 3]) {
    assert.throws(
      () => rt.updatePersona(a.id, { effort: bad }),
      (e) => e.status === 422 && /Effort is one of low, medium, high, xhigh, max/.test(e.message),
    );
    assert.throws(
      () => rt.createPersona({ handle: 'nope', effort: bad }),
      (e) => e.status === 422,
    );
  }
  assert.equal(rt.updatePersona(a.id, { effort: 'max' }).effort, 'max');
  assert.equal(rt.updatePersona(a.id, { description: 'x' }).effort, 'max', 'other edits keep it');
  const t2 = rt.createThread({ projectId: 'p1', title: 'T2', personaIds: [a.id] });
  rt.updatePersona(a.id, { effort: 'low' });
  const seen = [];
  adapter.next.push(async (c) => seen.push(c.persona.effort));
  rt.sendMessage(t2.id, { text: 'hi' });
  await settle(rt);
  assert.deepEqual(seen, ['max'], 'the session runs with the effort it started with, as with the model');
  assert.equal(rt.sessionsIn(t2.id)[0].personaSnapshot.effort, 'max');
  assert.ok(t && store);
});

test('#60: the model that answered and the effort a turn ran with are kept on the session', async () => {
  const { rt, t, adapter, store } = setup();
  adapter.next.push(async (c) => {
    c.reported({ model: 'claude-sonnet-5-5', effort: 'high' });
    c.reported({ model: 'claude-haiku-5-5' });
    c.reported({ model: '', effort: 'ultra' });
    c.reported({ model: 'x'.repeat(300) });
  });
  rt.sendMessage(t.id, { text: 'one' });
  await settle(rt);
  const se = store.state.sessions[rt.sessionsIn(t.id)[0].id];
  assert.equal(se.lastModel, 'x'.repeat(100), 'bounded');
  assert.equal(se.lastEffort, 'high', 'an unknown level is ignored');
  adapter.next.push(async (c) => c.reported({ model: 'claude-haiku-5-5', effort: 'low' }));
  rt.sendMessage(t.id, { text: 'two' });
  await settle(rt);
  assert.deepEqual([store.state.sessions[se.id].lastModel, store.state.sessions[se.id].lastEffort], ['claude-haiku-5-5', 'low']);
});

test('an agent asks for a tool that’s off; the person turns it on from the card, and the agent hears it (#104)', async () => {
  const { rt, store, t, adapter, a } = setup();
  /** @type {any} */
  let first;
  adapter.next.push(async (c) => {
    first = c.tools.ask_for_tool({ tool: 'shell', why: 'To run gh issue create.' });
    assert.equal(c.tools.ask_for_tool({ tool: 'shell', why: 'again' }).ok, true, 'a second ask points at the open card');
    assert.match(c.tools.ask_for_tool({ tool: 'corpus.search', why: 'x' }).message, /already on/);
    assert.match(c.tools.ask_for_tool({ tool: 'rm', why: 'x' }).message, /no tool “rm”/);
  });
  rt.sendMessage(t.id, { text: 'file two issues with gh' });
  await settle(rt);
  assert.equal(first.ok, true);
  const cards = store.items(t.id).filter((i) => i.kind === 'toolask');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].label, 'Run commands in the project folder');
  const se = rt.sessionsIn(t.id)[0];
  assert.equal(store.state.sessions[se.id].state, 'needs');
  assert.equal(store.state.sessions[se.id].needs.kind, 'toolask');
  rt.act(t.id, cards[0].id, 'on');
  await settle(rt);
  assert.deepEqual(store.state.personas[a.id].tools, ['corpus.search', 'shell']);
  assert.equal(store.item(t.id, cards[0].id).status, 'on');
  assert.ok(store.items(t.id).some((i) => i.kind === 'voice' && i.text === 'Turned on “Run commands in the project folder” for @alpha'));
  assert.equal(adapter.calls.at(-1).message.kind, 'notice');
  assert.match(adapter.calls.at(-1).message.text, /turned on shell \(Run commands in the project folder\) for you/);
  assert.throws(() => rt.act(t.id, cards[0].id, 'off'), /already answered/);
});

test('keeping a tool off leaves the persona as it was and tells the agent to go on without it (#104)', async () => {
  const { rt, store, t, adapter, a } = setup();
  adapter.next.push(async (c) => {
    c.tools.ask_for_tool({ tool: 'web.fetch', why: 'To read the docs.' });
  });
  rt.sendMessage(t.id, { text: 'read the docs' });
  await settle(rt);
  const card = store.items(t.id).find((i) => i.kind === 'toolask');
  rt.act(t.id, card.id, 'off');
  await settle(rt);
  assert.deepEqual(store.state.personas[a.id].tools, ['corpus.search']);
  assert.match(adapter.calls.at(-1).message.text, /kept web\.fetch off for you/);
  assert.equal(store.state.sessions[rt.sessionsIn(t.id)[0].id].needs, null);
});

test('#63 a reply with options in prose gets a lint turn that asks for the choice; showing it ends as a note', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) =>
    c.text('I can’t read the folder yet.\n\nTo unblock, pick one:\n1. Share the folder\n2. Paste the documents\n3. Point me at an export'),
  );
  adapter.next.push(async (c) => {
    c.tools.show_block({
      block: { id: 'unblock', type: 'choice', version: 1, fallback: 'Pick one', options: [{ id: 'share', label: 'Share the folder' }] },
    });
  });
  rt.sendMessage(t.id, { text: 'summarize the three documents' });
  await settle(rt);
  assert.equal(lints(adapter).length, 1);
  assert.deepEqual(
    lints(adapter)[0].message.problems.map((p) => p.code),
    ['options-in-prose'],
  );
  assert.ok(store.items(t.id).some((i) => i.kind === 'block' && i.block.id === 'unblock'));
  // The block it showed in the lint turn isn’t linted again, and the turn needs no reply.
  assert.equal(store.items(t.id).filter((i) => i.kind === 'agent').length, 1);
});

test('#63 a turn that showed a choice for its options isn’t linted', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.text('Two ways to go:\n1. Keyword search\n2. Embeddings\n\nWhich do you prefer?');
    c.tools.show_block({ block: { id: 'way', type: 'choice', version: 1, fallback: 'Pick', options: [{ id: 'kw', label: 'Keyword' }] } });
  });
  rt.sendMessage(t.id, { text: 'how should we search?' });
  await settle(rt);
  assert.equal(lints(adapter).length, 0);
});
