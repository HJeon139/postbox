// #852 slice 1a r2: a command the person confirmed in a confirm’s `commands` runs once, with no second card, when every
// rule of sprint4/852-s1a-confirm-packet-r2.md holds; anything else gets the card. Most cases run in Ask mode, where
// requestedCall never applies, so a pass here is this rule’s alone. Each call is one the turn’s stream showed, bound as
// permission_prompt binds it, unless the case is about an unbound one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import { ask, block, call, confirmed, LABEL, later, outcome, sha, theConfirm } from './confirm-grant-fixture.mjs';
import { cards, lines, setup, until } from './requested-setup.mjs';

test('#852 1a r3: a confirmed command runs with no card, as written, and its line names the confirm', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), ['ran']);
  assert.equal(cards(s).length, 0);
  const [line] = lines(s);
  assert.deepEqual([line.how, line.detail, line.blockItemId, line.sha256], ['confirmed', LABEL, theConfirm(s).id, sha(LABEL)]);
  assert.deepEqual(theConfirm(s).answer.commands, [sha(LABEL)]);
  assert.deepEqual(theConfirm(s).answer.ran, [sha(LABEL)]);
});

test('#852 1a r3: in Auto with no allowRequested and a judge that refuses, the confirm alone lets it run', async () => {
  const s = await setup({ judged: () => null });
  s.store.emit('project', { ...s.store.state.projects.p1, pushUrl: 'https://github.com/o/r.git' });
  s.rt.runGh = async (argv) => ({ status: 0, output: '', argv, timedOut: false });
  s.rt.updatePersona(s.p.id, { setup: { ...(s.p.setup ?? {}), allowRequested: false } });
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), ['ran']);
});

test('#852 1a r3: a fence in the statement grants nothing; only the commands field does', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, { ...block(undefined, `Runs:\n\n\`\`\`\n${LABEL}\n\`\`\``) }, [call(LABEL)]), ['card']);
});

test('#852 1a r3: any other command gets the card: a byte changed, a trailing space, one more command', async () => {
  for (const other of [LABEL.replace('896', '897'), `${LABEL} `, `${LABEL} && gh pr merge 896 --repo o/r`]) {
    const s = await ask();
    assert.deepEqual(await confirmed(s, block([LABEL]), [call(other)]), ['card'], other);
  }
});

test('#852 1a r3: the rest of the call must be plain: no sandbox off, no background', async () => {
  for (const extra of [{ dangerouslyDisableSandbox: true }, { run_in_background: true }]) {
    const s = await ask();
    const req = call(LABEL);
    req.input = { ...req.input, ...extra };
    assert.deepEqual(await confirmed(s, block([LABEL]), [req]), ['card'], JSON.stringify(extra));
  }
  const timed = await ask();
  const req = call(LABEL);
  req.input = { ...req.input, description: 'Label it', timeout: 60_000 };
  assert.deepEqual(await confirmed(timed, block([LABEL]), [req]), ['ran'], 'description and timeout are allowed');
});

test('#852 1a r3: an unbound ask (another backend, a forged prompt) gets a card and uses nothing', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL, { bound: false }), call(LABEL)]), ['card', 'ran']);
  const codex = await ask();
  assert.deepEqual(await confirmed(codex, block([LABEL]), [{ tool: 'Bash', summary: 'run a command', toolUseId: 'tu-codex' }]), ['card']);
});

test('#852 1a r3: a replay gets the card, in the same turn, a later one, and after a restart', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL), call(LABEL)]), ['ran', 'card']);
  assert.deepEqual(await later(s, [call(LABEL)]), ['card']);
  const rt = new Runtime({
    store: s.store,
    adapters: s.rt.adapters,
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: s.folder },
  });
  assert.deepEqual(await later({ ...s, rt }, [call(LABEL)]), ['card']);
});

test('#852 1a r3: two calls at once with the same command: one passes', async () => {
  const s = await ask();
  const answers = [];
  await confirmed(s, block([LABEL]), [], 'confirm', {
    before: (c) => {
      const a = call(LABEL);
      const b = call(LABEL);
      c.toolUse({ id: a.toolUseId, name: 'Bash', input: a.input });
      c.toolUse({ id: b.toolUseId, name: 'Bash', input: b.input });
      const both = [c.askPermission(a), c.askPermission(b)];
      // The second gets a card; answer it no, so the turn can end.
      void until(() => cards(s).length > 0).then(() => cards(s).length && s.rt.act(s.t.id, cards(s)[0].id, 'deny', {}));
      return Promise.all(both).then((r) => answers.push(...r.map(outcome)));
    },
  });
  await until(() => answers.length === 2);
  assert.deepEqual(answers.sort(), ['denied', 'ran'], 'the second got a card, answered no');
});

test('#852 1a r3: another session, or a subagent, can’t use the confirm', async () => {
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [other.id] });
  assert.deepEqual(await later({ ...s, t: t2 }, [call(LABEL)], s.rt.sessionsIn(t2.id)[0]), ['card']);
  const sub = await ask();
  assert.deepEqual(await confirmed(sub, block([LABEL]), [call(LABEL, { agentId: 'sub_1' })]), ['card']);
});

test('#852 1a r3: a cancel, an answer with no revision, a withdrawn or re-asked confirm grant nothing', async () => {
  const cancelled = await ask();
  assert.deepEqual(await confirmed(cancelled, block([LABEL]), [call(LABEL)], 'cancel'), ['card']);
  const unrevised = await ask();
  assert.deepEqual(await confirmed(unrevised, block([LABEL]), [call(LABEL)], 'confirm', { unrevised: true }), ['card']);
  assert.equal(theConfirm(unrevised).answer.commands, undefined);
  const withdrawn = await ask();
  await confirmed(withdrawn, block([LABEL]), []);
  withdrawn.rt.patchItem(withdrawn.t.id, theConfirm(withdrawn).id, { closed: { by: 'agent', handle: 'now', reason: 'x', at: Date.now() } });
  assert.deepEqual(await later(withdrawn, [call(LABEL)]), ['card']);
  const reasked = await ask();
  await confirmed(reasked, block([LABEL]), []);
  reasked.rt.patchItem(reasked.t.id, theConfirm(reasked).id, { revision: 2 });
  assert.deepEqual(await later(reasked, [call(LABEL)]), ['card']);
});

test('#852 1a r3: the time limits: 15 minutes from delivery, 24 hours from the answer', async () => {
  for (const [label, shift, allowed] of [
    ['delivered 16 minutes ago', { readAt: -16 * 60_000 }, 'card'],
    ['answered 25 hours ago', { at: -25 * 3_600_000 }, 'card'],
    ['inside both', { readAt: -14 * 60_000, at: -23 * 3_600_000 }, 'ran'],
  ]) {
    const s = await ask();
    await confirmed(s, block([LABEL]), []);
    const it = theConfirm(s);
    const answer = { ...it.answer };
    for (const [k, d] of Object.entries(shift)) answer[k] = Date.now() + d;
    s.rt.patchItem(s.t.id, it.id, { answer });
    // As if all of it happened that long ago: the person’s message before the click, too.
    for (const x of s.store.items(s.t.id)) if (x.kind === 'user') s.rt.patchItem(s.t.id, x.id, { at: Math.min(x.at, answer.at - 1) });
    assert.deepEqual(await later(s, [call(LABEL)]), [allowed], label);
  }
});

test('#852 1a r3: the person’s message after the click, or a Stop, takes the confirm back', async () => {
  const said = await ask();
  await confirmed(said, block([LABEL]), []);
  said.rt.addItem(said.t.id, { kind: 'user', text: 'Wait, don’t.' });
  assert.deepEqual(await later(said, [call(LABEL)]), ['card']);
  const stopped = await ask();
  await confirmed(stopped, block([LABEL]), []);
  const se = stopped.rt.sessionsIn(stopped.t.id)[0];
  stopped.rt.addItem(stopped.t.id, { kind: 'agent', sessionId: se.id, handle: 'now', status: 'stopped', text: '' });
  assert.deepEqual(await later(stopped, [call(LABEL)]), ['card']);
});

test('#852 1a r3: the person’s own ask rule still gives the card', async () => {
  const s = await ask();
  const se = s.rt.sessionsIn(s.t.id)[0];
  s.rt.updateSession(se.id, { rules: { allow: [], ask: ['Bash(gh pr edit:*)'], deny: [] } });
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), ['card']);
});

test('#852 1a r3: a call that isn’t Bash gets the card, and a confirm can’t show a command that isn’t a shape', async () => {
  const s = await ask();
  const mcp = { tool: 'mcp__tally__create_ticket', summary: 'create a ticket', input: { command: LABEL }, bound: true, toolUseId: 'tu-mcp' };
  assert.deepEqual(await confirmed(s, block([LABEL]), [mcp]), ['card']);
  const shown = await ask();
  let reply;
  shown.next.push(async (c) => {
    reply = c.tools.show_block({ block: block(['git -C /tmp/x push origin x']) });
  });
  shown.rt.sendMessage(shown.t.id, { text: 'Push it.' });
  await until(() => !shown.rt.turns.size);
  assert.equal(reply.ok, false);
  assert.match(reply.message, /lone git push/);
});

test('#852 1a r3: Postbox runs a confirmed gh shape itself, with exactly its words, and the agent’s own never runs', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), ['ran']);
  assert.deepEqual(s.ran, [['pr', 'edit', '896', '--repo', 'o/r', '--add-label', 'ready for integrator']]);
  assert.deepEqual(lines(s)[0].gh, { argv: s.ran[0], status: 0, output: s.ran[0].join(' ') });
});
test('#852 1a r3: a host turn’s call never uses the rule; it asks through its host', async () => {
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const { settledCall } = await import('../server/write-intent.mjs');
  const se = s.rt.sessionsIn(s.t.id)[0];
  let found;
  s.next.push(async (c) => {
    const turn = s.rt.turns.get(se.id);
    const req = call(LABEL);
    c.toolUse({ id: req.toolUseId, name: 'Bash', input: req.input });
    turn.remote = { hostId: 'h1' };
    found = await settledCall(s.rt, se.id, req);
    turn.remote = undefined;
  });
  s.rt.deliver(se.id, { kind: 'notice', text: 'Go on.' }, { threadId: s.t.id });
  await until(() => found !== undefined && !s.rt.turns.size);
  assert.equal(found, null);
  assert.equal(lines(s).length, 0);
});

test('#852 1a r3: a confirm another session showed never grants, even if this session’s list names it', async () => {
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [other.id] });
  const [se2] = s.rt.sessionsIn(t2.id);
  s.rt.updateSession(se2.id, { confirms: [{ threadId: s.t.id, itemId: theConfirm(s).id, at: Date.now() }] });
  assert.deepEqual(await later({ ...s, t: t2 }, [call(LABEL)], se2), ['card']);
});

test('#852 1a r3: the person’s 🚩 or 👎 on the confirm, or their message in a topic thread, takes it back', async () => {
  for (const emoji of ['🚩', '👎']) {
    const s = await ask();
    await confirmed(s, block([LABEL]), []);
    const it = theConfirm(s);
    s.rt.patchItem(s.t.id, it.id, { reactions: [{ emoji, at: Date.now() }] });
    assert.deepEqual(await later(s, [call(LABEL)]), ['card'], emoji);
  }
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const topic = s.rt.createThread({ projectId: 'p1', title: 'Topic', kind: 'topic', parentId: s.t.id });
  s.rt.addItem(topic.id, { kind: 'user', text: 'Hold on.' });
  assert.deepEqual(await later(s, [call(LABEL)]), ['card'], 'a topic thread message');
});

test('#852 1a r3: with the store closed at the call, it gets the card and nothing runs', async () => {
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const { settledCall } = await import('../server/write-intent.mjs');
  const se = s.rt.sessionsIn(s.t.id)[0];
  let found;
  s.next.push(async (c) => {
    const req = call(LABEL);
    c.toolUse({ id: req.toolUseId, name: 'Bash', input: req.input });
    s.store.writable = false;
    try {
      found = await settledCall(s.rt, se.id, req);
    } finally {
      s.store.writable = true;
    }
  });
  s.rt.deliver(se.id, { kind: 'notice', text: 'Go on.' }, { threadId: s.t.id });
  await until(() => found !== undefined && !s.rt.turns.size);
  assert.equal(found, null);
  assert.deepEqual(s.ran, []);
});
