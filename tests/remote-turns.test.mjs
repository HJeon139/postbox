// The runtime’s remote turns (#120, the plan’s L5; server/remote/turns.mjs): a persona on a host runs through the
// real Claude Code adapter and remote process against tests/fake-daemon.mjs, with a fake host manager (the interface
// L5a builds) over the fake daemon’s streams. The stream is the recorded Claude Code turn the fake daemon replays by
// default (tests/fixtures/claude-code/permission-allow.jsonl, claude 2.1.296 on this computer: no stream recorded on a
// host exists yet). Nothing here starts a process or opens a connection. The rig is tests/remote-turns-helpers.mjs;
// turn states and Stop, a restart, stops and hosts are in tests/remote-turns-*.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STOPPED_TEXT } from '../server/remote/turns.mjs';
import { NOT_YOUR_PROMPT } from '../shared/mcp-tools.mjs';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { rig, running, settled, sleep, starts, until } from './remote-turns-helpers.mjs';

// ── 1. Delivery: welcome, turn ID, snapshot ───────────────────────────────────────────

test('#120 L5: a remote turn gets its host turn ID persisted and the conversation snapshot before start, with the host folder', async () => {
  const r = rig();
  const turn = await running(r);
  const kinds = r.d.received.map((m) => m.type);
  assert.ok(kinds.indexOf('snapshot') < kinds.indexOf('start'), `snapshot before start: ${kinds.join(', ')}`);
  const snap = r.d.received.find((m) => m.type === 'snapshot');
  const start = starts(r.d)[0];
  assert.equal(snap.turn, turn);
  assert.equal(start.turn, turn);
  assert.equal(start.folder, '/home/user/postbox-work/coder');
  // Persisted with the session before anything ran.
  assert.deepEqual(
    { hostId: r.se().remoteTurn.hostId, turn: r.se().remoteTurn.turn, state: r.se().remoteTurn.state },
    { hostId: r.host.id, turn, state: 'running' },
  );
  // The snapshot is read_conversation’s and read_message’s, in the runtime’s own words.
  assert.equal(snap.home, r.t.id);
  assert.deepEqual(
    snap.threads.map((th) => th.id),
    r.rt.conversationThreads(r.t.id),
  );
  const mine = snap.threads[0].items.find((i) => i.line === 'You: hi');
  assert.ok(mine, JSON.stringify(snap.threads[0].items));
  assert.equal(mine.text, r.rt.readLine(r.store.item(r.t.id, mine.id), r.se(), Number.POSITIVE_INFINITY));
  // The host is needed for the turn’s life.
  assert.deepEqual(r.hosts.calls.need, [[r.host.id, 'turn']]);
  assert.equal(r.f.calls.length, 0);
  // Kept current while it runs: a new item goes as snapshot-items. What changed as the turn started (the thread’s
  // lastSpeaker, a full snapshot) goes first, so only the new item is left to send.
  r.rt.remote.flushSnapshots();
  const it = r.rt.addItem(r.t.id, { kind: 'user', text: 'one more thing' });
  r.rt.remote.flushSnapshots();
  await until(() => r.d.turns.get(turn).snapshotItems.length > 0, 'snapshot-items');
  const items = r.d.turns.get(turn).snapshotItems[0];
  assert.equal(items.thread, r.t.id);
  assert.deepEqual(items.items, [{ id: it.id, line: 'You: one more thing', text: 'You: one more thing' }]);
  r.d.end(turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.deepEqual(r.hosts.calls.release, [[r.host.id, 'turn']]);
  const reply = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.text);
  assert.match(reply.text, /hello\.txt/);
});

test('#120 L5: the project’s folder on the host is the turn’s folder; every item counts in the snapshot, shown or not', async () => {
  const r = rig();
  r.store.emit('project', { ...r.store.state.projects.p1, hostFolders: { [r.host.id]: '/srv/work' } });
  r.rt.addItem(r.t.id, { kind: 'system', variant: 'wake', from: 'you', to: 'coder' });
  r.rt.addItem(r.t.id, { kind: 'agent', sessionId: 'other', handle: 'other', text: '', status: 'failed' });
  const turn = await running(r);
  assert.equal(starts(r.d)[0].folder, '/srv/work');
  const snap = r.d.received.find((m) => m.type === 'snapshot' && m.turn === turn);
  const lines = snap.threads[0].items.map((i) => i.line);
  // The failed reply shows nothing but still counts, as read_conversation counts it when paging.
  assert.ok(lines.includes(''), JSON.stringify(lines));
  assert.ok(lines.includes('You woke @coder'));
  r.d.end(turn);
  await settled(r);
});

// ── 2. The daemon’s tool calls and prompts ───────────────────────────────────────────

test('#120 L5: a queued tool from the host goes through the laptop’s tools once, and is replied to each time it’s sent', async () => {
  const r = rig();
  const turn = await running(r);
  const block = { id: 'pick', type: 'choice', version: 1, title: 'Pick', fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] };
  const id = r.d.tool(turn, 'show_block', { block });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.equal(r.d.replies[0].ok, true);
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'block' && i.block?.id === 'pick').length, 1);
  // The daemon sends it again after a hello until it hears the reply: the same reply, and no second block.
  r.link.hear({ type: 'tool', turn, id, name: 'show_block', args: { block } });
  await until(() => r.link.sent.filter((m) => m.type === 'reply' && m.id === id).length === 2, 'the repeat’s reply');
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'block' && i.block?.id === 'pick').length, 1);
  // An asked one gets its answer’s text, after an urgent note waiting for the agent, as on the laptop (#229).
  r.rt.updateSession(r.se().id, { context: ['[Postbox] URGENT: a subagent needs you.'] });
  r.d.tool(turn, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.length === 2, 'the search’s reply');
  assert.match(r.d.replies[1].text, /^\[Postbox\] URGENT: a subagent needs you\.\n\n.*about whales/s);
  assert.deepEqual(r.se().context, [], 'the note is given once');
  r.d.end(turn);
  await settled(r);
  // A call from a turn that has ended, heard while the next one runs, is refused, as on the laptop.
  const next = await running(r, 'again');
  r.link.hear({ type: 'tool', turn, id: 'late', name: 'define_term', args: { term: 'x', definition: 'y' } });
  await until(() => r.link.sent.some((m) => m.type === 'reply' && m.id === 'late'), 'the late call’s refusal');
  assert.deepEqual((({ ok, text }) => ({ ok, text }))(r.link.sent.find((m) => m.type === 'reply' && m.id === 'late')), { ok: false, text: STOPPED_TEXT });
  assert.equal(r.store.state.glossary[r.t.id]?.x, undefined);
  r.d.end(next);
  await settled(r);
});

test('#120 L5: react from the host reaches the laptop’s reactTool, as server/mcp.mjs’s does, and its answer says which way it went', async () => {
  const r = rig();
  const turn = await running(r);
  const mine = r.store.items(r.t.id).find((i) => i.kind === 'user');
  r.d.tool(turn, 'react', { id: mine.id, emoji: '👍' });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.deepEqual((({ ok, text }) => ({ ok, text }))(r.d.replies[0]), { ok: true, text: 'You reacted 👍 to the person’s message.' });
  assert.deepEqual(
    r.store.item(r.t.id, mine.id).reactions.map((x) => [x.emoji, x.by]),
    [['👍', r.se().id]],
  );
  // Again takes it back; an id that isn’t there is refused with what to do.
  r.d.tool(turn, 'react', { id: mine.id, emoji: '👍' });
  await until(() => r.d.replies.length === 2, 'the second reply');
  assert.equal(r.d.replies[1].text, 'You took back your 👍 on the person’s message.');
  r.d.tool(turn, 'react', { id: 'it_nope', emoji: '👍' });
  await until(() => r.d.replies.length === 3, 'the refusal');
  assert.deepEqual((({ ok, text }) => ({ ok, text }))(r.d.replies[2]), {
    ok: false,
    text: 'There’s no item “it_nope” in this conversation. read_conversation gives each item’s id.',
  });
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: a prompt from the host is the laptop’s permission card, and the person’s answer goes back as answer', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.deepEqual(card.remote, { hostId: r.host.id, turn, prompt: id });
  assert.equal(card.tool, FIXTURE_PROMPT.tool_name);
  assert.equal(r.se().remoteTurn.state, 'waiting');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0], { turn, id, result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  assert.equal(r.se().remoteTurn.state, 'running');
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: a host prompt’s card has no CARD_WAIT_MS timer of the laptop’s: its host expires it (permissionWaitMax)', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.ok(card.remote, 'a host prompt’s card');
  assert.equal(r.rt.permissionWaits.get(card.id).timer, null, 'no laptop expiry: the host’s prompt-expired ends it');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: a prompt from a backend that doesn’t ask through permission_prompt gets the laptop’s refusal, and no card', async () => {
  const r = rig();
  const turn = await running(r);
  // A stand-in for a backend that asks another way (capabilities.promptTool false), whose shim wasn’t told so.
  const claude = /** @type {any} */ (r.rt.adapters.get('claude-code'));
  claude.capabilities = { ...claude.capabilities, promptTool: false };
  const id = r.d.prompt(turn);
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0], { turn, id, result: { behavior: 'deny', message: NOT_YOUR_PROMPT.content[0].text } });
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'permission').length, 0);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: a prompt the host expired or the harness canceled marks its card (the expiry as nobody answering), and no answer goes', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the first card');
  r.d.expire(turn, a);
  await until(() => r.store.items(r.t.id).find((i) => i.remote?.prompt === a).status === 'expired', 'the card expired');
  const b = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === b), 'the second card');
  r.link.hear({ type: 'prompt-expired', turn, id: b, at: 1_760_000_000_000, reason: 'canceled' });
  assert.equal(r.store.items(r.t.id).find((i) => i.remote?.prompt === b).status, 'canceled');
  // The page says “nobody answered in time” only for the host’s expiry (L6), not for one the harness canceled.
  assert.equal(r.store.items(r.t.id).find((i) => i.remote?.prompt === a).noAnswer, true);
  assert.equal(r.store.items(r.t.id).find((i) => i.remote?.prompt === b).noAnswer, undefined);
  await sleep(10);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 0);
  assert.equal(r.se().needs, null);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5 invariant: a prompt-expired for a prompt the person already answered is ignored, and the card keeps its answer', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === id), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  r.rt.resolvePermission(r.t.id, card.id, 'deny', { reason: 'not now' });
  await until(() => r.d.answers.length === 1, 'the answer');
  const before = { ...r.store.item(r.t.id, card.id) };
  // The answer raced the host’s expiry: a no-prompt error for it, then the expiry, both tolerated.
  r.link.hear({ type: 'error', code: 'no-prompt', re: 'answer', turn, message: `Prompt ${id} in turn ${turn} isn’t waiting any more.` });
  r.link.hear({ type: 'prompt-expired', turn, id, at: 1_760_000_000_000 });
  r.link.hear({ type: 'prompt-expired', turn, id, at: 1_760_000_000_001, reason: 'canceled' });
  const after = r.store.item(r.t.id, card.id);
  assert.equal(after.status, 'denied');
  assert.equal(after.reason, 'not now');
  assert.equal(after.answeredAt, before.answeredAt);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 1);
  // A repeat of the prompt (after a hello) gets the same answer again, with no second card.
  r.link.hear({ type: 'prompt', id, turn, request: FIXTURE_PROMPT });
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 2);
  assert.deepEqual(r.link.sent.filter((m) => m.type === 'answer')[1].result, r.link.sent.filter((m) => m.type === 'answer')[0].result);
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'permission').length, 1);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: an expiry the daemon couldn’t record marks the open card ended', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === id), 'the card');
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, message: `Couldn’t write down that prompt ${id} expired.` });
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  assert.equal(card.status, 'ended');
  await sleep(10);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 0);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: an expiry the daemon couldn’t record names its prompt, so exactly that card ends with others open', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  const b = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).filter((i) => i.kind === 'permission').length === 2, 'two cards');
  r.d.expireUnrecorded(turn, b);
  const card = (id) => r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  await until(() => card(b).status === 'ended', 'the named card to end');
  assert.equal(card(a).status, 'open', 'the other card still waits');
  // The ended one’s repeat (a hello) shows nothing again; the open one is still answered.
  r.link.hear({ type: 'prompt', id: b, turn, request: FIXTURE_PROMPT });
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'permission').length, 2);
  r.rt.resolvePermission(r.t.id, card(a).id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.equal(r.d.answers[0].id, a);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer' && m.prompt === b).length, 0);
  // And one the person already answered keeps its answer when such an error comes late.
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, id: a, message: 'Couldn’t write it down.' });
  assert.equal(card(a).status, 'allowed');
  r.d.end(turn);
  await settled(r);
});
