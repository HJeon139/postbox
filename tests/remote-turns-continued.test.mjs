// The runtime’s remote turns (#120, the plan’s L5; tests/remote-turns.test.mjs says how): a turn continued on its
// host, attached again after a restart or resumed after Interrupted or Sign-in needed, ends as the turn it continues
// would have (server/remote/turns-origin.mjs): a woken agent answers where it was woken, and wakes the agent that
// woke it only by an @-mention (#377), a summary is posted back, an app check settles its app, a lint turn isn’t linted
// again, and Retry asks what that turn was asked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintMessage } from '../server/checks.mjs';
import * as arrange from './arrange.mjs';
import { fixtureLines } from './fake-daemon.mjs';
import { rig, settled, starts, startUp, until } from './remote-turns-helpers.mjs';

/** Another agent, on this computer, in the conversation: what it’s sent is what its mock got. @param {any} r @param {any[]} [got] */
function lead(r, got = []) {
  r.rt.adapters.register({ name: 'mock', deliver: async (/** @type {any} */ _se, /** @type {any} */ m) => void got.push(m) });
  const p = arrange.persona(r.rt, 'lead') ?? r.rt.createPersona({ handle: 'lead', backend: 'mock' });
  return { se: r.rt.ensureSession(r.t.id, p.id), got };
}

const all = (/** @type {any} */ r) => Object.values(r.store.state.items).flat();
const threadOf = (/** @type {any} */ r, /** @type {any} */ it) => Object.keys(r.store.state.items).find((k) => r.store.state.items[k].includes(it));
const reads = (/** @type {any} */ d, /** @type {string} */ turn) => d.received.filter((/** @type {any} */ m) => m.type === 'read' && m.turn === turn);
const reply = (/** @type {any} */ r) => all(r).find((i) => i.kind === 'agent' && i.handle === 'coder' && i.status === 'done' && i.text);

/** Waits for the newest start’s turn to run on the host, and returns its ID. @param {any} r @param {number} n */
async function onHost(r, n) {
  await until(() => starts(r.d).length === n && r.d.turns.has(starts(r.d)[n - 1].turn), `start ${n} on the host`);
  const turn = starts(r.d)[n - 1].turn;
  await until(() => reads(r.d, turn).length > 0, 'its read');
  return turn;
}

/** Postbox restarts during the turn: the next one, over the same store and daemon, attached again. @param {any} first @param {string} turn @param {any[]} [got] */
async function restart(first, turn, got = []) {
  await first.rt.stopTurns({ graceMs: 0 });
  first.d.drop();
  first.d.connect();
  const next = rig({ store: first.store, d: first.d });
  lead(next, got);
  startUp(next);
  await until(() => reads(next.d, turn).length > 1, 'the attach’s read');
  return next;
}

/** The fixture’s stream, its reply starting with an @-mention. @param {string} handle */
const mentioning = (handle) => fixtureLines().map((l) => l.replaceAll('"I ran ', `"@${handle} I ran `));

/** The fixture’s stream without its result line, and two to end it with: that line, and the sign-in error the adapter
 * names (as tests/remote-turns-states.test.mjs has it). */
const ending = () => {
  const lines = fixtureLines();
  const i = lines.findIndex((l) => JSON.parse(l).type === 'result');
  const signIn = JSON.stringify({ ...JSON.parse(lines[i]), is_error: true, error: 'authentication_failed', result: 'Failed to authenticate.' });
  return { lines: lines.slice(0, i), result: lines[i], signIn };
};

test('#120, #377: a wake Interrupted on the host and resumed on its own answers where it was woken, and its @-mention wakes the waker', async () => {
  const r = rig({ daemon: { lines: mentioning('lead') } });
  const { se: a, got } = lead(r);
  assert.equal(r.rt.agentWake(a.id, 'coder', 'Is hello.txt there?').ok, true);
  const first = await onHost(r, 1);
  r.d.interrupt(first);
  await until(() => all(r).some((i) => i.kind === 'agent' && i.status === 'failed'), 'Interrupted');
  const failed = all(r).find((i) => i.kind === 'agent' && i.status === 'failed');
  r.d.end(await onHost(r, 2));
  await until(() => got.length === 1, 'its @-mention to wake the waker');
  assert.equal(got[0].from, '@coder');
  assert.match(got[0].text, /hello\.txt/);
  const answer = reply(r);
  assert.equal(threadOf(r, answer), threadOf(r, failed), 'it answers where it was woken');
  assert.deepEqual(answer.woke, { by: 'lead' });
  await settled(r);
});

test('#485: a wake whose link gave up with its reply written wakes no one yet: the turn may still be on the host', async () => {
  const r = rig({ daemon: { lines: mentioning('lead') } });
  const { se: a, got } = lead(r);
  assert.equal(r.rt.agentWake(a.id, 'coder', 'Is hello.txt there?').ok, true);
  await onHost(r, 1);
  await until(() => all(r).some((i) => i.kind === 'agent' && i.handle === 'coder' && /@lead/.test(i.text ?? '')), 'its reply, with the mention');
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost', 'still on the host, as far as Postbox knows');
  assert.ok(all(r).some((i) => i.kind === 'agent' && i.handle === 'coder' && i.status === 'failed'));
  // It’s attached again once the host is back, and its mentions wake their agents when it ends there.
  assert.equal(got.length, 0, 'the failed reply’s @-mention woke no one');
});

test('#120, #377: a wake stopped with Sign-in needed and resumed by the person answers where it was woken, and wakes no one by itself', async () => {
  const { lines, result, signIn } = ending();
  const r = rig({ daemon: { lines } });
  const { se: a, got } = lead(r);
  assert.equal(r.rt.agentWake(a.id, 'coder', 'Is hello.txt there?').ok, true);
  const first = await onHost(r, 1);
  r.d.append(first, signIn);
  r.d.end(first, { code: 1, signal: null });
  await until(() => r.se().remoteTurn.state === 'signin', 'Sign-in needed');
  await settled(r);
  r.rt.resumeRemote(r.se().id);
  const again = await onHost(r, 2);
  r.d.append(again, result);
  r.d.end(again);
  await settled(r);
  assert.deepEqual(reply(r).woke, { by: 'lead' });
  assert.equal(threadOf(r, reply(r)), r.t.id, 'in the conversation, where it was woken');
  assert.equal(got.length, 0, 'a reply wakes the waker only by an @-mention (#377)');
});

test('#120, #225: a summary attached again after a restart is posted back once, and its @-mentions wake no one', async () => {
  const r = rig({ daemon: { lines: mentioning('lead') } });
  lead(r);
  const root = arrange.post(r.rt, r.t.id, { kind: 'agent', sessionId: r.se().id, handle: 'coder', text: 'Plan the release', status: 'done' });
  const { threadId: topic } = r.rt.startTopic(r.t.id, root.id);
  r.rt.summarizeBack(topic);
  const turn = await onHost(r, 1);
  const got = [];
  const next = await restart(r, turn, got);
  next.d.end(turn);
  await settled(next);
  const shared = next.store.items(r.t.id).filter((i) => i.kind === 'shared' && i.summary);
  assert.equal(shared.length, 1, 'posted to the conversation once');
  assert.match(shared[0].text, /^@lead I ran/);
  assert.equal(got.length, 0, 'its mention woke no one');
  assert.equal(next.store.state.threads[topic].summaryPending, null);
});

test('#120: an app check attached again after a restart that sends no new version shows the app with a note', async () => {
  const r = rig();
  const se = r.se();
  r.store.emit('app', { id: 'app_1', sessionId: se.id, threadId: r.t.id, current: 1, check: { status: 'fixing', attempt: 1, problems: [] } });
  r.rt.deliver(se.id, { kind: 'app-check', appId: 'app_1', problems: [{ code: 'no-render', message: 'It drew nothing.' }] }, { threadId: r.t.id });
  const turn = await onHost(r, 1);
  const next = await restart(r, turn);
  next.d.end(turn);
  await settled(next);
  assert.equal(next.store.state.apps.app_1.check.status, 'note');
});

test('#120: a lint turn Interrupted on the host and resumed is still a lint turn: its reply isn’t linted again', async () => {
  const r = rig();
  const problem = { code: 'undefined-term', message: 'Define “Widget”.', scope: { kind: 'term', term: 'Widget', key: 'widget' } };
  r.rt.deliver(r.se().id, lintMessage([problem]), { threadId: r.t.id });
  r.d.interrupt(await onHost(r, 1));
  r.d.end(await onHost(r, 2));
  await settled(r);
  const answer = reply(r);
  assert.equal(answer.lintReply, true);
  assert.equal(arrange.lint(r.rt, r.se().id, answer.turnId, [problem]), false, 'what’s found in it never goes back as a lint turn');
});

test('#1138’s class: a reply settled before a restart and replayed after it hands its @-mention over once', async () => {
  // The host turn’s reply closes mid-turn, so its mention is handed over then. The attach after a restart replays the
  // turn from its start, marks that reply replaced and posts it again: the same mention is keyed by the host turn, so
  // it’s stored once (server/mention-entries.mjs, replayKey).
  const lines = mentioning('lead');
  // The reply’s message again, as a new message whose words have no mention: the words after the block.
  const from = lines.findIndex((l) => l.includes('"message_start"') && l.includes('msg_011CgFTsfUqRmERyis7eEc6P'));
  const to = lines.findIndex((l, n) => n > from && l.includes('"message_stop"'));
  const more = lines.slice(from, to + 1).map((l) => {
    const j = JSON.parse(l.replaceAll('msg_011CgFTsfUqRmERyis7eEc6P', 'msg_more'));
    if (j.uuid) j.uuid = `more-${j.uuid}`;
    if (j.event?.delta?.type === 'text_delta') j.event.delta.text = j.event.delta.text.startsWith('@lead') ? 'One more thing.' : '';
    for (const c of j.message?.content ?? []) if (c.type === 'text') c.text = 'One more thing.';
    return JSON.stringify(j);
  });
  const result = lines.find((l) => JSON.parse(l).type === 'result');
  // The turn runs on until the test ends it, after the restart.
  const r = rig({ daemon: { lines: lines.filter((l) => l !== result) } });
  const got = [];
  lead(r, got);
  r.rt.sendMessage(r.t.id, { text: '@coder go' });
  const turn = await onHost(r, 1);
  await until(() => all(r).some((i) => i.kind === 'agent' && i.handle === 'coder' && /@lead I ran/.test(i.text ?? '')), 'its reply, with the mention');
  // A block it shows, then more words, close the reply’s first part, so its mention is handed over while the turn runs.
  r.d.tool(turn, 'show_block', {
    block: { id: 'pick', type: 'choice', version: 1, title: 'Pick', fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] },
  });
  await until(() => all(r).some((i) => i.kind === 'block'), 'the block');
  for (const l of more) r.d.append(turn, l);
  await until(() => got.length === 1, 'the closed part’s mention handed over mid-turn');
  const next = await restart(r, turn, got);
  next.d.append(turn, result);
  next.d.end(turn);
  await settled(next);
  assert.ok(
    all(next).some((i) => i.kind === 'agent' && i.handle === 'coder' && i.status === 'replaced'),
    'the replay replaced the settled reply',
  );
  assert.equal(got.filter((m) => JSON.stringify(m).includes('@lead I ran')).length, 1, 'lead was handed the mention once');
  const entries = Object.values(next.store.state.inbox)
    .flat()
    .filter((e) => e.from === 'coder');
  assert.equal(entries.length, 1, 'and stored once: the replay’s copy made no second entry');
});
