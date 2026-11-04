// A permission card that expired before the person answered it (#721, server/permission-expiry.mjs): it stops counting
// toward “needs you”, the agent that asked hears in its next turn that it can ask again, once per card, and a closed
// card the room still needs you for can be dismissed. Declining isn’t expiry: the agent already hears that in its call.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { expireWait } from '../server/permission-cards.mjs';
import { tellExpired } from '../server/permission-expiry.mjs';
import { endCard } from '../server/remote/turns-prompts.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folders = [];
after(() => Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))));
const EXPIRED_NOTE =
  /^\[Postbox\] Your request to run the deploy \(`make deploy`\) expired before the person answered it, so it didn’t run\. Ask again if you still need it\.$/;

/** A Claude Code agent whose turns the test scripts: each step is one turn, and every turn’s message is kept. */
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'pb-expiry-'));
  folders.push(folder);
  const store = new Store(null);
  const calls = [];
  const next = [];
  const adapter = {
    name: 'claude-code',
    async folderFor() {
      return folder;
    },
    async deliver(_session, message, ctx) {
      calls.push(message);
      const step = next.shift() ?? (async (c) => c.text('ok'));
      await step(ctx);
    },
  };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'deployer', backend: 'claude-code', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** Starts a turn whose call waits on a card for the deploy, and returns the card once it shows. */
  const ask = async () => {
    const answers = [];
    next.push(async (c) => {
      answers.push(await c.askPermission({ tool: 'Bash', summary: 'run the deploy', detail: 'make deploy', input: { command: 'make deploy' } }));
      c.text('ok');
    });
    rt.sendMessage(t.id, { text: 'deploy it' });
    const card = () => store.pending.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    for (let i = 0; i < 100 && !card(); i++) await new Promise(setImmediate);
    assert.ok(card(), 'the card shows');
    return { card: card(), answers };
  };
  return { store, rt, t, se, calls, ask, now: () => store.state.sessions[se.id] };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
const notes = (se) => (se.context ?? []).filter((n) => /expired before the person answered/.test(n));

test('#721 a card that expires unanswered tells the agent in its next turn which request expired, and to ask again', async () => {
  const { rt, t, calls, ask, now } = await setup();
  const { card } = await ask();
  expireWait(rt, card.id);
  await settle(rt);
  assert.equal(now().needs, null, 'it no longer needs you');
  assert.equal(notes(now()).length, 1, 'one note waits for its next turn');
  rt.sendMessage(t.id, { text: 'what happened?' });
  await settle(rt);
  const heard = calls.at(-1).context ?? [];
  assert.equal(heard.filter((n) => EXPIRED_NOTE.test(n)).length, 1, `its next turn names the request: ${JSON.stringify(heard)}`);
  rt.sendMessage(t.id, { text: 'and now?' });
  await settle(rt);
  assert.equal((calls.at(-1).context ?? []).filter((n) => EXPIRED_NOTE.test(n)).length, 0, 'the turn after doesn’t hear it again');
});

test('#721 Stop expires the card and clears the need, but sends no note: the person stopped it, as on main', async () => {
  const { rt, t, ask, now } = await setup();
  const { card } = await ask();
  rt.stop(now().id);
  await settle(rt);
  assert.equal(rt.store.item(t.id, card.id).status, 'expired');
  assert.equal(now().needs, null);
  assert.equal(notes(now()).length, 0);
});

test('#721 a card whose summary is generic names its command in the note, so the agent knows what to ask for again', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, {
    kind: 'permission',
    sessionId: now().id,
    handle: 'deployer',
    tool: 'Bash',
    summary: 'run a command',
    detail: 'git push origin fix/721',
    status: 'open',
  });
  tellExpired(rt, t.id, it.id);
  assert.match(notes(now())[0], /Your request to run a command \(`git push origin fix\/721`\) expired/);
});

test('#721 the note is sent once per card, however many paths tell it', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, { kind: 'permission', sessionId: now().id, handle: 'deployer', tool: 'Bash', summary: 'run the deploy', status: 'expired' });
  tellExpired(rt, t.id, it.id);
  tellExpired(rt, t.id, it.id);
  assert.equal(notes(now()).length, 1);
});

test('#721 an archived agent gets no note: nobody would read it', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, { kind: 'permission', sessionId: now().id, handle: 'deployer', tool: 'Bash', summary: 'run the deploy', status: 'expired' });
  rt.updateSession(now().id, { archived: true });
  tellExpired(rt, t.id, it.id);
  assert.equal(notes(now()).length, 0);
});

test('#721 a host card kept open across a restart, which its host then expires with no wait here, clears the need and tells', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, { kind: 'permission', sessionId: now().id, handle: 'deployer', tool: 'Bash', summary: 'run the deploy', status: 'open' });
  rt.updateSession(now().id, { needs: { kind: 'permission', itemId: it.id, text: 'x' }, state: 'needs' });
  endCard({ rt, now: () => Date.now() }, { it, threadId: t.id }, 'expired', 'Expired on its host.', Date.now());
  assert.equal(rt.store.item(t.id, it.id).status, 'expired');
  assert.equal(now().needs, null);
  assert.equal(notes(now()).length, 1);
});

test('#721 a card the person declined sends no expiry note: the agent hears the refusal in its call', async () => {
  const { rt, t, ask, now } = await setup();
  const { card, answers } = await ask();
  rt.resolvePermission(t.id, card.id, 'deny', { reason: 'not today' });
  await settle(rt);
  assert.equal(answers[0].allow, false);
  assert.equal(notes(now()).length, 0);
});

test('#721 after a restart, a card that can’t be answered any more tells the agent it expired', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, {
    kind: 'permission',
    sessionId: now().id,
    handle: 'deployer',
    tool: 'Bash',
    summary: 'run the deploy',
    detail: 'make deploy',
    status: 'open',
  });
  rt.expireStalePermissions();
  assert.equal(rt.store.item(t.id, it.id).status, 'expired');
  assert.deepEqual(
    notes(now()).map((n) => EXPIRED_NOTE.test(n)),
    [true],
  );
});

test('#721 Dismiss on an expired card that still needs you clears the need, and marks the card dismissed', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, { kind: 'permission', sessionId: now().id, handle: 'deployer', tool: 'Bash', summary: 'run the deploy', status: 'expired' });
  // The need a restart left on the card it expired (#633 fixes that path; Dismiss is the backstop).
  rt.updateSession(now().id, { state: 'needs', needs: { kind: 'permission', itemId: it.id, text: '@deployer asks to run the deploy' } });
  assert.deepEqual(rt.act(t.id, it.id, 'dismiss'), { ok: true });
  assert.equal(now().needs, null);
  assert.equal(now().state, 'idle');
  assert.equal(rt.store.item(t.id, it.id).dismissed, true);
  assert.equal(rt.store.item(t.id, it.id).status, 'expired', 'it keeps saying what became of it');
});

test('#721 Dismiss on a closed card leaves a need for another card alone', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, { kind: 'permission', sessionId: now().id, handle: 'deployer', tool: 'Bash', summary: 'run the deploy', status: 'expired' });
  const needs = { kind: 'block', itemId: 'it_other', text: 'a choice' };
  rt.updateSession(now().id, { state: 'needs', needs });
  rt.act(t.id, it.id, 'dismiss');
  assert.deepEqual(now().needs, needs);
});

test('#721 Dismiss on a card still waiting for an answer is refused, and the card and its need stay', async () => {
  const { rt, t, ask, now } = await setup();
  const { card } = await ask();
  assert.throws(
    () => rt.act(t.id, card.id, 'dismiss'),
    (e) => e.status === 409 && /still waiting for your answer/.test(e.message),
  );
  assert.equal(rt.store.item(t.id, card.id).status, 'open');
  assert.equal(rt.store.item(t.id, card.id).dismissed, undefined);
  assert.equal(now().needs?.itemId, card.id);
  rt.resolvePermission(t.id, card.id, 'allow');
  await settle(rt);
});

test('#721 the note quotes a command as it is: its Markdown kept, its backticks fenced', async () => {
  const { rt, t, now } = await setup();
  const it = rt.addItem(t.id, {
    kind: 'permission',
    sessionId: now().id,
    handle: 'deployer',
    tool: 'Bash',
    summary: 'run a command',
    detail: 'ls *.log &&\n  echo `x`',
    status: 'expired',
  });
  tellExpired(rt, t.id, it.id);
  assert.match(notes(now())[0], /Your request to run a command \(`` ls \*\.log && echo `x` ``\) expired/);
});

test('#721 on #633: an expired card that was the need hands it to the next card that waits, not to nothing', async () => {
  const { rt, t, ask, now } = await setup();
  const { card } = await ask();
  const app = rt.addItem(t.id, { kind: 'appsend', sessionId: now().id, appId: 'a1', title: 'App', events: [{ action: 'x' }], status: 'open' });
  assert.equal(now().needs?.itemId, card.id, 'the permission ranks ahead');
  expireWait(rt, card.id);
  await settle(rt);
  assert.equal(now().needs?.itemId, app.id, 'the app card is the need now');
  assert.equal(notes(now()).length, 1);
});

test('#721 closing a card moves the need before the card’s patch, so the page redraws the card with nothing waiting on it', async () => {
  const { rt, t, ask, now } = await setup();
  const { card } = await ask();
  const order = [];
  const update = rt.updateSession.bind(rt);
  const patch = rt.patchItem.bind(rt);
  rt.updateSession = (id, p) => {
    if (Object.hasOwn(p, 'needs')) order.push('need');
    return update(id, p);
  };
  rt.patchItem = (threadId, id, p) => {
    if (id === card.id && Object.hasOwn(p, 'status')) order.push('card');
    return patch(threadId, id, p);
  };
  rt.resolvePermission(t.id, card.id, 'allow');
  rt.updateSession = update;
  rt.patchItem = patch;
  await settle(rt);
  assert.deepEqual(order.slice(0, 2), ['need', 'card']);
  assert.equal(now().needs, null);
});
