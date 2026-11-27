// #1748: an agent shows a form with show_block and keeps working in the same turn. On 25 Nov the sidebar said “1 open
// form” while the top bar said “Nothing needs you” for over an hour, because the session's need was set only at the
// turn's end (turn-needs.mjs, needsAfter). An asking block now counts from when it's shown.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askToSee } from '../server/view-app/consent.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import * as arrange from './arrange.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle } from './side-threads-fixture.mjs';
import { until } from './stop-reply-fixture.mjs';

const form = (id) => ({
  block: { id, type: 'form', version: 1, title: 'Which window?', fallback: 'Which window?', fields: [{ id: 'w', label: 'Window', kind: 'text' }] },
});

/** Starts a turn for @alpha that runs `body` with its tools, then holds until released. */
function holdTurn(r, body) {
  let release = () => {};
  const done = new Promise((res) => {
    release = res;
  });
  r.adapter.next.push(async (c) => {
    c.text('working on it');
    await body(c.tools);
    await done;
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  return () => release();
}

/** @alpha's need once it has one, while its turn runs. @param {any} r */
const needed = async (r) => {
  await until(() => r.rt.s.sessions[r.alpha.id].needs, 'the need');
  return r.rt.s.sessions[r.alpha.id].needs;
};

test('a form shown mid-turn is the need at once, and the agent stays working', async () => {
  const r = room();
  const release = holdTurn(r, (tools) => tools.show_block(form('f1')));
  await needed(r);
  const se = r.rt.s.sessions[r.alpha.id];
  assert.ok(r.rt.turns.has(r.alpha.id), 'the turn is still running');
  assert.equal(se.needs?.kind, 'block');
  assert.equal(se.needs?.text, 'Which window?');
  assert.ok(needsYouNow(se), 'the top bar counts it');
  assert.notEqual(se.state, 'needs', 'the agent is still working, not waiting');
  release();
  await settle(r.rt);
  assert.equal(r.rt.s.sessions[r.alpha.id].needs?.kind, 'block', 'and the turn’s end keeps it');
});

test('a non-asking block shown mid-turn is no need', async () => {
  const r = room();
  const release = holdTurn(r, (tools) => tools.show_block({ block: { id: 'c1', type: 'card', version: 1, fallback: 'Note', body: 'Note' } }));
  await until(() => r.rt.s.items[r.t.id].some((it) => it.kind === 'block'), 'the card');
  assert.equal(r.rt.s.sessions[r.alpha.id].needs ?? null, null);
  release();
  await settle(r.rt);
});

test('answering the form mid-turn releases the need while the turn runs on', async () => {
  const r = room();
  const release = holdTurn(r, (tools) => tools.show_block(form('f2')));
  await needed(r);
  const itemId = r.rt.s.sessions[r.alpha.id].needs?.itemId;
  assert.ok(itemId);
  await r.rt.act(r.t.id, itemId, 'submit', { w: '30 days' });
  assert.equal(r.rt.s.sessions[r.alpha.id].needs ?? null, null);
  release();
  await settle(r.rt);
});

test('with two forms shown mid-turn, answering one leaves the other as the need', async () => {
  const r = room();
  const release = holdTurn(r, async (tools) => {
    tools.show_block(form('f3'));
    await needed(r);
    // A tick later, so the second form is the newer one by its time.
    await new Promise((res) => setTimeout(res, 2));
    tools.show_block(form('f4'));
  });
  await until(
    () =>
      r.rt.s.items[r.t.id].filter((it) => it.kind === 'block').length === 2 &&
      r.rt.s.sessions[r.alpha.id].needs?.itemId !== r.rt.s.items[r.t.id].find((it) => it.block?.id === 'f3')?.id,
    'the second form as the need',
  );
  const second = r.rt.s.sessions[r.alpha.id].needs?.itemId;
  const items = r.rt.s.items[r.t.id].filter((it) => it.kind === 'block');
  const first = items.find((it) => it.block.id === 'f3').id;
  assert.equal(second, items.find((it) => it.block.id === 'f4').id, 'the newer form is the need');
  await r.rt.act(r.t.id, second, 'submit', { w: '30 days' });
  assert.equal(r.rt.s.sessions[r.alpha.id].needs?.itemId, first, 'the older form still waits');
  release();
  await settle(r.rt);
});

test('a form shown with no turn (an older one, re-shown) is no need, as on main (#69)', () => {
  const r = room();
  r.rt.toolsFor(r.alpha.id, null).show_block(form('f5'));
  assert.equal(r.rt.s.sessions[r.alpha.id].needs ?? null, null);
});

test('an update that asks again mid-turn is the need from then, as a form just shown is', async () => {
  const r = room();
  /** @type {any} */
  let tools = null;
  const release = holdTurn(r, (t) => {
    tools = t;
    t.show_block(form('f6'));
  });
  const first = await needed(r);
  await r.rt.act(r.t.id, first.itemId, 'submit', { w: '30 days' });
  assert.equal(r.rt.s.sessions[r.alpha.id].needs ?? null, null, 'answered: nothing needs you');
  // The agent read the answer and asks something new, in the same turn.
  const again = { block: { ...form('f6').block, title: 'Which window, for spend?', fallback: 'Which window, for spend?' } };
  // The first try hands it the answer it hadn't read (#123), as a real agent's would; then the update asks.
  assert.match(tools.update_block(again).message, /The person answered/);
  const updated = tools.update_block(again);
  assert.ok(updated.ok, updated.message);
  const se = await needed(r);
  assert.equal(se.itemId, first.itemId, 'the same block, asking again');
  assert.ok(r.rt.turns.has(r.alpha.id), 'the turn is still running');
  assert.ok(needsYouNow(r.rt.s.sessions[r.alpha.id]), 'the top bar counts it');
  release();
  await settle(r.rt);
});

test('stopping the turn drops the need its form made: the form waits quietly, as before #1748', async () => {
  const r = room();
  const release = holdTurn(r, (tools) => tools.show_block(form('f7')));
  await needed(r);
  arrange.stopTurn(r.rt, r.alpha.id);
  // The stand-in harness ends when it's let go, as a stopped CLI exits.
  release();
  await until(() => !arrange.exiting(r.rt, r.alpha.id), 'the stopped turn to exit');
  await settle(r.rt);
  const se = r.rt.s.sessions[r.alpha.id];
  assert.equal(se.needs ?? null, null, 'no need after Stop');
  assert.ok(!needsYouNow(se), 'the top bar doesn’t count it');
  assert.notEqual(se.state, 'needs', 'and the agent doesn’t ring');
  assert.ok(
    r.rt.s.items[r.t.id].some((it) => it.block?.id === 'f7' && !it.answered),
    'the form is still there to answer',
  );
});

for (const kept of ['its turn', 'only the block']) {
  test(`stopping a woken turn gives the need back to the older form it kept (${kept}), as before #1748`, async () => {
    const r = room();
    const older = r.block(); // open, from turn_last
    // A session from before lastTurnId was kept holds the block only as the woken turn's keptId.
    if (kept === 'only the block') arrange.setSession(r.rt, r.alpha.id, { lastTurnId: null });
    r.setNeed('block', older.id);
    /** @type {any} */
    let tools = null;
    const work = held();
    r.adapter.next.push(async (c) => {
      tools = c.tools;
      await work.step(c);
    });
    r.rt.turnService.run(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' }); // not you moving on
    await until(() => tools, 'the woken turn');
    tools.show_block(form('f8'));
    await until(() => r.needs()?.itemId !== older.id, 'the new form as the need');
    arrange.stopTurn(r.rt, r.alpha.id);
    work.release();
    await until(() => !arrange.exiting(r.rt, r.alpha.id), 'the stopped turn to exit');
    await settle(r.rt);
    assert.equal(r.needs()?.itemId, older.id, 'the older form is the need again');
  });
}

// #1868: a tool request and a view request a turn raises are turn-tied asks, as a form is, so each counts from when it’s
// raised too. Before, each became the need mid-turn only when some other card was released, and otherwise at the
// turn’s end, so whether the person saw it depended on what else happened in the turn.
const raisers = {
  toolask: (/** @type {any} */ _r, /** @type {any} */ tools) => tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' }),
  viewask: (/** @type {any} */ r) => askToSee(r.rt, r.alpha.id, r.t.id, () => {}),
};

for (const [kind, raise] of Object.entries(raisers)) {
  test(`a ${kind} raised mid-turn is the need at once, with no pulse or notice until the turn ends`, async () => {
    const r = room();
    /** @type {any[]} */
    const heard = [];
    r.rt.store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && heard.push(ev.data));
    const release = holdTurn(r, (tools) => raise(r, tools));
    await until(() => r.rt.s.items[r.t.id].some((it) => it.kind === kind), `the ${kind} card`);
    const se = r.rt.s.sessions[r.alpha.id];
    assert.ok(r.rt.turns.has(r.alpha.id), 'the turn is still running');
    assert.equal(se.needs?.kind, kind, 'the card is the need while the turn runs on');
    assert.ok(needsYouNow(se), 'the top bar counts it');
    assert.notEqual(se.state, 'needs', 'no pulse: the agent is still working');
    assert.deepEqual(heard, [], 'no notice while the turn runs on');
    release();
    await settle(r.rt);
    assert.equal(r.rt.s.sessions[r.alpha.id].needs?.kind, kind, 'and the turn’s end keeps it');
    assert.equal(r.rt.s.sessions[r.alpha.id].state, 'needs', 'the pulse comes at the turn’s end');
  });
}
