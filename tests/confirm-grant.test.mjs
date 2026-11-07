// #852 slice 1a: a command the person confirmed runs once, byte for byte, in the same agent’s session, with no second
// card. Packet: sprint4/852-s1a-confirm-packet-r1.md, with the person’s answers (15 minutes from delivery and 24 hours
// from the answer; Ask mode passes; whatever allowRequested is; the squash path in requestedCall stays). Most cases run
// in Ask mode, where requestedCall never applies, so a pass here is this rule’s alone.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { afterBlock, asking, bash, cards, confirm, lines, setup, until } from './requested-setup.mjs';

const LABEL = 'h=$(gh pr view 896 --json headRefOid -q .headRefOid); [ "$h" = 0d4a73bb ] && gh pr edit 896 --add-label "ready for integrator"';
const fence = (...commands) => `Confirming runs this:\n\n${commands.map((c) => `\`\`\`\n${c}\n\`\`\``).join('\n\nThen:\n\n')}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const theConfirm = (s) => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.type === 'confirm');

/** The same agent's next turn, started by the person's message, making these calls. */
async function laterTurn(s, reqs) {
  const answers = [];
  s.next.push(asking(s, reqs, answers));
  s.rt.sendMessage(s.t.id, { text: 'Go on.' });
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers.map((a) => a.allow);
}

test('#852 1a: a confirmed command runs with no card, as written, and its line names the confirm', async () => {
  const s = await setup({ permissionMode: 'ask' });
  assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], [bash(LABEL)]), [true]);
  assert.equal(cards(s).length, 0);
  const [line] = lines(s);
  assert.equal(line.how, 'confirmed');
  assert.equal(line.detail, LABEL);
  assert.equal(line.blockItemId, theConfirm(s).id);
  assert.equal(line.sha256, sha(LABEL));
  assert.deepEqual(theConfirm(s).answer.commands, [sha(LABEL)], 'what was on screen, recorded at the click');
});

test('#852 1a: in Auto with no allowRequested and a judge that refuses, the confirm alone lets it run', async () => {
  const s = await setup({ judged: () => null });
  s.rt.updatePersona(s.p.id, { setup: { ...(s.p.setup ?? {}), allowRequested: false } });
  assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], [bash(LABEL)]), [true]);
});

test('#852 1a: any other command gets the card: a byte changed, a trailing space, one more command, another PR', async () => {
  for (const other of [LABEL.replace('896', '897'), `${LABEL} `, `${LABEL} && gh pr merge 896`, LABEL.replace('ready for', 'ready  for')]) {
    const s = await setup({ permissionMode: 'ask' });
    assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], [bash(other)]), [false], other);
    assert.equal(lines(s).length, 0);
  }
});

test('#852 1a: a replay gets the card, in the same turn or a later one, and after a restart', async () => {
  const s = await setup({ permissionMode: 'ask' });
  assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], [bash(LABEL), bash(LABEL)]), [true, false]);
  assert.deepEqual(await laterTurn(s, [bash(LABEL)]), [false]);
  const rt = new Runtime({
    store: s.store,
    adapters: s.rt.adapters,
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: s.folder },
  });
  const after = { ...s, rt };
  assert.deepEqual(await laterTurn(after, [bash(LABEL)]), [false], 'the line in the log still counts after a restart');
  assert.equal(lines(s).length, 1);
});

test('#852 1a: a restart between the confirm and the call still lets it run once, within the window', async () => {
  const s = await setup({ permissionMode: 'ask' });
  s.next.push(async (c) => c.tools.show_block({ block: confirm(fence(LABEL)) }));
  s.rt.sendMessage(s.t.id, { text: 'Get it ready.' });
  await until(() => !s.rt.turns.size);
  // Answered and delivered, then Postbox restarts before the agent's call.
  s.next.push(async (c) => c.text('Running it next.'));
  await s.rt.act(s.t.id, theConfirm(s).id, 'confirm', {});
  await until(() => !s.rt.turns.size && theConfirm(s).answer.read === true);
  const rt = new Runtime({
    store: s.store,
    adapters: new AdapterRegistry().register(s.rt.adapters.get('claude-code')),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: s.folder },
  });
  assert.deepEqual(await laterTurn({ ...s, rt }, [bash(LABEL), bash(LABEL)]), [true, false]);
});

test('#852 1a: another agent’s session can’t use the person’s confirm, and the confirm’s own agent still can', async () => {
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  // Another persona, in a conversation of its own: another session, which never showed this confirm.
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [other.id] });
  const s2 = { ...s, t: t2 };
  assert.deepEqual(await laterTurn(s2, [bash(LABEL)]), [false], 'the other agent gets a card');
  assert.deepEqual(await laterTurn(s, [bash(LABEL)]), [true], 'the other agent’s attempt used nothing');
});

test('#852 1a: a subagent of the same session gets the card', async () => {
  const s = await setup({ permissionMode: 'ask' });
  assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], [bash(LABEL, { agentId: 'sub_1' })]), [false]);
});

test('#852 1a: expired: delivered more than 15 minutes ago, or answered more than 24 hours ago', async () => {
  for (const [label, shift] of [
    ['delivered 16 minutes ago', { readAt: -16 * 60_000 }],
    ['answered 25 hours ago', { at: -25 * 3_600_000 }],
  ]) {
    const s = await setup({ permissionMode: 'ask' });
    await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
    const it = theConfirm(s);
    const answer = { ...it.answer };
    for (const [k, d] of Object.entries(shift)) answer[k] = Date.now() + d;
    s.rt.patchItem(s.t.id, it.id, { answer });
    assert.deepEqual(await laterTurn(s, [bash(LABEL)]), [false], label);
  }
  // Within both limits it runs, which shows the two above failed on their limit alone.
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  const it = theConfirm(s);
  s.rt.patchItem(s.t.id, it.id, { answer: { ...it.answer, readAt: Date.now() - 14 * 60_000, at: Date.now() - 23 * 3_600_000 } });
  assert.deepEqual(await laterTurn(s, [bash(LABEL)]), [true]);
});

test('#852 1a: a confirm the person cancelled grants nothing, and records no commands', async () => {
  const s = await setup({ permissionMode: 'ask' });
  assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['cancel', {}], [bash(LABEL)]), [false]);
  assert.equal(theConfirm(s).answer.commands, undefined);
});

test('#852 1a: a confirm withdrawn after the answer, or asked again at a new revision, grants nothing', async () => {
  const withdrawn = await setup({ permissionMode: 'ask' });
  await afterBlock(withdrawn, confirm(fence(LABEL)), ['confirm', {}], []);
  withdrawn.next.push(async (c) => c.tools.update_block({ block: { id: 'push', withdraw: 'Not needed after all.' } }));
  withdrawn.rt.sendMessage(withdrawn.t.id, { text: 'Never mind.' });
  await until(() => !withdrawn.rt.turns.size && !!theConfirm(withdrawn).closed);
  assert.deepEqual(await laterTurn(withdrawn, [bash(LABEL)]), [false]);

  const again = await setup({ permissionMode: 'ask' });
  await afterBlock(again, confirm(fence(LABEL)), ['confirm', {}], []);
  again.next.push(async (c) => c.tools.update_block({ block: { ...confirm(fence(LABEL)), statement: `${fence(LABEL)}\n\nOne more note.` } }));
  again.rt.sendMessage(again.t.id, { text: 'Change it.' });
  await until(() => !again.rt.turns.size);
  assert.equal(theConfirm(again).answered, false, 'it asks again');
  assert.deepEqual(await laterTurn(again, [bash(LABEL)]), [false]);
});

test('#852 1a: only a fenced block counts, not inline code; two fences each run once', async () => {
  const inline = await setup({ permissionMode: 'ask' });
  assert.deepEqual(await afterBlock(inline, confirm(`Confirming runs \`${LABEL}\`.`), ['confirm', {}], [bash(LABEL)]), [false]);
  const two = await setup({ permissionMode: 'ask' });
  const second = 'gh pr view 896 --json labels -q "[.labels[].name]"';
  assert.deepEqual(await afterBlock(two, confirm(fence(LABEL, second)), ['confirm', {}], [bash(second), bash(LABEL), bash(second)]), [true, true, false]);
});

test('#852 1a: a fence with characters that show differently from their bytes grants nothing', async () => {
  for (const hidden of ['\u200b', '\u202e', '\u2066', '\ufeff', '\u001b[2K', '\r']) {
    const command = LABEL.replace('--add-label', `--add-label${hidden}`);
    const s = await setup({ permissionMode: 'ask' });
    assert.deepEqual(await afterBlock(s, confirm(fence(command)), ['confirm', {}], [bash(command)]), [false], JSON.stringify(hidden));
    assert.deepEqual(theConfirm(s).answer.commands ?? [], [], 'no grant recorded for it');
  }
});

test('#852 1a: the grant is what was on screen at the click, even if the statement changes without asking again', async () => {
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  const it = theConfirm(s);
  const swapped = 'gh pr merge 896 --admin';
  s.rt.patchItem(s.t.id, it.id, { block: { ...it.block, statement: fence(swapped) } });
  assert.deepEqual(await laterTurn(s, [bash(swapped), bash(LABEL)]), [false, true]);
});

test('#852 1a: a call that isn’t Bash gets the card, whatever the confirm shows', async () => {
  const s = await setup({ permissionMode: 'ask' });
  const mcp = { tool: 'mcp__tally__create_ticket', summary: 'create a ticket', input: { command: LABEL } };
  assert.deepEqual(await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], [mcp]), [false]);
});

test('#852 1a: with the store closed, the call gets a card: nothing runs unrecorded', async () => {
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  const turnDone = laterTurnClosed(s);
  assert.equal(await turnDone, null);
  assert.equal(lines(s).length, 0);
});

/** Asks for the call with the store closed; gives settledCall's answer, which must be no answer (a card). */
async function laterTurnClosed(s) {
  const { settledCall } = await import('../server/write-intent.mjs');
  let found;
  s.next.push(async (c) => {
    s.store.writable = false;
    try {
      void c;
      found = await settledCall(s.rt, s.rt.sessionsIn(s.t.id)[0].id, bash(LABEL));
    } finally {
      s.store.writable = true;
    }
  });
  s.rt.sendMessage(s.t.id, { text: 'Go on.' });
  await until(() => found !== undefined && !s.rt.turns.size);
  return found;
}

/** settledCall's answer for this call, asked from inside a turn of the confirm's agent; `during` runs first. */
async function settledInTurn(s, req, during = () => {}) {
  const { settledCall } = await import('../server/write-intent.mjs');
  const sessionId = s.rt.sessionsIn(s.t.id)[0].id;
  let found;
  s.next.push(async () => {
    const turn = s.rt.turns.get(sessionId);
    const was = turn.remote;
    during(turn);
    found = await settledCall(s.rt, sessionId, req);
    // The rest of the turn ends as a local one: only the call was asked as a host turn's.
    turn.remote = was;
  });
  s.rt.sendMessage(s.t.id, { text: 'Go on.' });
  await until(() => found !== undefined && !s.rt.turns.size);
  return found;
}

test('#852 1a: a host turn’s call gets its card through its host, never this rule', async () => {
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  assert.equal(
    await settledInTurn(s, bash(LABEL), (turn) => {
      turn.remote = { hostId: 'h1' };
    }),
    null,
  );
  assert.equal(lines(s).length, 0);
});

test('#852 1a: a confirm another session showed never grants, even if this session’s list names it', async () => {
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  const it = theConfirm(s);
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [other.id] });
  const [se2] = s.rt.sessionsIn(t2.id);
  // A list that names the first agent's confirm: the block's own session is still checked.
  s.rt.updateSession(se2.id, { confirms: [{ threadId: s.t.id, itemId: it.id, at: Date.now() }] });
  assert.deepEqual(await laterTurn({ ...s, t: t2 }, [bash(LABEL)]), [false]);
});

test('#852 1a: an answer for an older revision grants nothing, even if it’s still on the item', async () => {
  const s = await setup({ permissionMode: 'ask' });
  await afterBlock(s, confirm(fence(LABEL)), ['confirm', {}], []);
  const it = theConfirm(s);
  s.rt.patchItem(s.t.id, it.id, { revision: (it.revision ?? 1) + 1 });
  assert.deepEqual(await laterTurn(s, [bash(LABEL)]), [false]);
});
