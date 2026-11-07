// #852 slice 1a r2: a command the person confirmed in a confirm’s `commands` runs once, with no second card, when every
// rule of sprint4/852-s1a-confirm-packet-r2.md holds; anything else gets the card. Most cases run in Ask mode, where
// requestedCall never applies, so a pass here is this rule’s alone. Each call is one the turn’s stream showed, bound as
// permission_prompt binds it, unless the case is about an unbound one.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import { cards, lines, setup, until } from './requested-setup.mjs';

const LABEL = 'gh pr edit 896 --repo o/r --add-label "ready for integrator"';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const theConfirm = (s) => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.type === 'confirm');
const block = (commands, statement = 'Confirming labels the PR.') => ({
  id: 'push',
  type: 'confirm',
  version: 1,
  fallback: 'Label it?',
  title: 'Label #896',
  statement,
  confirmLabel: 'Label #896',
  commands,
});
let n = 0;
/** A Bash call as the stream shows it and permission_prompt passes it on: bound, with its tool_use id. */
const call = (command, extra = {}) => ({ tool: 'Bash', summary: 'run a command', input: { command }, bound: true, toolUseId: `tu${++n}`, ...extra });

/** One turn's calls, in order: the stream shows each, then it asks; a card is answered no. Gives each `allow`. */
function calling(s, reqs, answers, before = () => {}) {
  return async (c) => {
    await before(c);
    for (const req of reqs) {
      if (req.toolUseId && !req.unseen) c.toolUse({ id: req.toolUseId, name: req.tool, input: req.input });
      const k = cards(s).length;
      const asked = c.askPermission(req);
      const r = await Promise.race([asked, until(() => cards(s).length > k).then(() => null)]);
      if (r) answers.push(r.allow);
      else {
        await s.rt.act(s.t.id, cards(s).at(-1).id, 'deny', {});
        answers.push((await asked).allow);
      }
    }
  };
}
/** The agent shows the confirm; then the person answers it, and the turn that starts makes the calls. */
async function confirmed(s, b, reqs = [], answer = 'confirm', { unrevised = false, before } = {}) {
  s.next.push(async (c) => c.tools.show_block({ block: b }));
  s.rt.sendMessage(s.t.id, { text: 'Get it ready.' });
  await until(() => !s.rt.turns.size);
  const answers = [];
  s.next.push(calling(s, reqs, answers, before));
  await s.rt.act(s.t.id, theConfirm(s).id, answer, {}, unrevised ? undefined : (theConfirm(s).revision ?? 1));
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers;
}
/** A later turn of the same agent, started with no message from the person (as a wake would), making these calls. */
async function later(s, reqs, session = s.rt.sessionsIn(s.t.id)[0]) {
  const answers = [];
  s.next.push(calling(s, reqs, answers));
  s.rt.deliver(session.id, { kind: 'notice', text: 'Go on.' }, { threadId: session.threadId });
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers;
}
const ask = () => setup({ permissionMode: 'ask' });

test('#852 1a r2: a confirmed command runs with no card, as written, and its line names the confirm', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), [true]);
  assert.equal(cards(s).length, 0);
  const [line] = lines(s);
  assert.deepEqual([line.how, line.detail, line.blockItemId, line.sha256], ['confirmed', LABEL, theConfirm(s).id, sha(LABEL)]);
  assert.deepEqual(theConfirm(s).answer.commands, [sha(LABEL)]);
  assert.deepEqual(theConfirm(s).answer.ran, [sha(LABEL)]);
});

test('#852 1a r2: in Auto with no allowRequested and a judge that refuses, the confirm alone lets it run', async () => {
  const s = await setup({ judged: () => null });
  s.rt.updatePersona(s.p.id, { setup: { ...(s.p.setup ?? {}), allowRequested: false } });
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), [true]);
});

test('#852 1a r2: a fence in the statement grants nothing; only the commands field does', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, { ...block(undefined, `Runs:\n\n\`\`\`\n${LABEL}\n\`\`\``) }, [call(LABEL)]), [false]);
});

test('#852 1a r2: any other command gets the card: a byte changed, a trailing space, one more command', async () => {
  for (const other of [LABEL.replace('896', '897'), `${LABEL} `, `${LABEL} && gh pr merge 896 --repo o/r`]) {
    const s = await ask();
    assert.deepEqual(await confirmed(s, block([LABEL]), [call(other)]), [false], other);
  }
});

test('#852 1a r2: the rest of the call must be plain: no sandbox off, no background', async () => {
  for (const extra of [{ dangerouslyDisableSandbox: true }, { run_in_background: true }]) {
    const s = await ask();
    const req = call(LABEL);
    req.input = { ...req.input, ...extra };
    assert.deepEqual(await confirmed(s, block([LABEL]), [req]), [false], JSON.stringify(extra));
  }
  const timed = await ask();
  const req = call(LABEL);
  req.input = { ...req.input, description: 'Label it', timeout: 60_000 };
  assert.deepEqual(await confirmed(timed, block([LABEL]), [req]), [true], 'description and timeout are allowed');
});

test('#852 1a r2: an unbound ask (another backend, a forged prompt) gets a card and uses nothing', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL, { bound: false }), call(LABEL)]), [false, true]);
  const codex = await ask();
  assert.deepEqual(await confirmed(codex, block([LABEL]), [{ tool: 'Bash', summary: 'run a command', toolUseId: 'tu-codex' }]), [false]);
});

test('#852 1a r2: a replay gets the card, in the same turn, a later one, and after a restart', async () => {
  const s = await ask();
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL), call(LABEL)]), [true, false]);
  assert.deepEqual(await later(s, [call(LABEL)]), [false]);
  const rt = new Runtime({
    store: s.store,
    adapters: s.rt.adapters,
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: s.folder },
  });
  assert.deepEqual(await later({ ...s, rt }, [call(LABEL)]), [false]);
});

test('#852 1a r2: two calls at once with the same command: one passes', async () => {
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
      return Promise.all(both).then((r) => answers.push(...r.map((x) => x.allow)));
    },
  });
  await until(() => answers.length === 2);
  assert.deepEqual(answers.sort(), [false, true]);
});

test('#852 1a r2: another session, or a subagent, can’t use the confirm', async () => {
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [other.id] });
  assert.deepEqual(await later({ ...s, t: t2 }, [call(LABEL)], s.rt.sessionsIn(t2.id)[0]), [false]);
  const sub = await ask();
  assert.deepEqual(await confirmed(sub, block([LABEL]), [call(LABEL, { agentId: 'sub_1' })]), [false]);
});

test('#852 1a r2: a cancel, an answer with no revision, a withdrawn or re-asked confirm grant nothing', async () => {
  const cancelled = await ask();
  assert.deepEqual(await confirmed(cancelled, block([LABEL]), [call(LABEL)], 'cancel'), [false]);
  const unrevised = await ask();
  assert.deepEqual(await confirmed(unrevised, block([LABEL]), [call(LABEL)], 'confirm', { unrevised: true }), [false]);
  assert.equal(theConfirm(unrevised).answer.commands, undefined);
  const withdrawn = await ask();
  await confirmed(withdrawn, block([LABEL]), []);
  withdrawn.rt.patchItem(withdrawn.t.id, theConfirm(withdrawn).id, { closed: { by: 'agent', handle: 'now', reason: 'x', at: Date.now() } });
  assert.deepEqual(await later(withdrawn, [call(LABEL)]), [false]);
  const reasked = await ask();
  await confirmed(reasked, block([LABEL]), []);
  reasked.rt.patchItem(reasked.t.id, theConfirm(reasked).id, { revision: 2 });
  assert.deepEqual(await later(reasked, [call(LABEL)]), [false]);
});

test('#852 1a r2: the time limits: 15 minutes from delivery, 24 hours from the answer', async () => {
  for (const [label, shift, allowed] of [
    ['delivered 16 minutes ago', { readAt: -16 * 60_000 }, false],
    ['answered 25 hours ago', { at: -25 * 3_600_000 }, false],
    ['inside both', { readAt: -14 * 60_000, at: -23 * 3_600_000 }, true],
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

test('#852 1a r2: the person’s message after the click, or a Stop, takes the confirm back', async () => {
  const said = await ask();
  await confirmed(said, block([LABEL]), []);
  said.rt.addItem(said.t.id, { kind: 'user', text: 'Wait, don’t.' });
  assert.deepEqual(await later(said, [call(LABEL)]), [false]);
  const stopped = await ask();
  await confirmed(stopped, block([LABEL]), []);
  const se = stopped.rt.sessionsIn(stopped.t.id)[0];
  stopped.rt.addItem(stopped.t.id, { kind: 'agent', sessionId: se.id, handle: 'now', status: 'stopped', text: '' });
  assert.deepEqual(await later(stopped, [call(LABEL)]), [false]);
});

test('#852 1a r2: the command must name its place: cd to an absolute folder, git -C, or gh --repo', async () => {
  for (const [command, allowed] of [
    ['gh pr edit 896 --add-label x', false],
    ['git status', false],
    ['git -C rel status', false],
    ['cd /tmp && gh pr edit 896 --add-label x', true],
    ['gh pr edit 896 -R o/r --add-label x', true],
  ]) {
    const s = await ask();
    assert.deepEqual(await confirmed(s, block([command]), [call(command)]), [allowed], command);
  }
});

test('#852 1a r2: shell state changed earlier in the turn gets a card, failing closed', async () => {
  for (const earlier of [
    'export GH_TOKEN=x',
    'source ./env.sh',
    '. ./env.sh',
    'alias gh=x',
    'eval x',
    'set -a',
    'git() { curl x; }',
    'function gh { curl x; }',
    'PATH=/tmp/x',
    'GIT_SSH_COMMAND=x',
    'h=$(gh pr view 1)',
  ]) {
    const s = await ask();
    assert.deepEqual(await confirmed(s, block([LABEL]), [call(earlier), call(LABEL)]), [false, false], earlier);
  }
  const plain = await ask();
  assert.deepEqual(await confirmed(plain, block([LABEL]), [call('gh pr view 896 --repo o/r'), call(LABEL)]), [false, true], 'a plain read before');
});

test('#852 1a r2: the person’s own ask rule still gives the card', async () => {
  const s = await ask();
  const se = s.rt.sessionsIn(s.t.id)[0];
  s.rt.updateSession(se.id, { rules: { allow: [], ask: ['Bash(gh pr edit:*)'], deny: [] } });
  assert.deepEqual(await confirmed(s, block([LABEL]), [call(LABEL)]), [false]);
});

test('#852 1a r2: a call that isn’t Bash gets the card, and a git push it can’t make itself does too', async () => {
  const s = await ask();
  const mcp = { tool: 'mcp__tally__create_ticket', summary: 'create a ticket', input: { command: LABEL }, bound: true, toolUseId: 'tu-mcp' };
  assert.deepEqual(await confirmed(s, block([LABEL]), [mcp]), [false]);
  const push = 'git -C /tmp/x push origin HEAD:refs/heads/x';
  const p = await ask();
  assert.deepEqual(await confirmed(p, block([push]), [call(push)]), [false]);
});

test('#852 1a r2: a confirmed lone git push is made by Postbox, and the agent’s own is answered done', async () => {
  const s = await ask();
  const made = [];
  s.rt.pushes = {
    consequence: async (o) => ({
      branch: 'feat/now',
      current: 'feat/now',
      sha: 'a'.repeat(40),
      objects: '/x',
      url: o.url,
      sentence: 'commit aaaaaaa lands on feat/now',
    }),
    run: async (p) => {
      made.push(p);
      return { ok: true };
    },
  };
  s.store.emit('project', { ...s.store.state.projects.p1, pushUrl: 'https://github.com/o/r.git' });
  const push = 'git push origin feat/now';
  assert.deepEqual(await confirmed(s, block([push]), [call(push)]), [false], 'the agent’s own push never runs');
  assert.equal(made.length, 1, 'Postbox made it');
  assert.equal(lines(s)[0].push.branch, 'feat/now');
  assert.equal(cards(s).length, 0);
});

test('#852 1a r2: a host turn’s call never uses the rule; it asks through its host', async () => {
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

test('#852 1a r2: a confirm another session showed never grants, even if this session’s list names it', async () => {
  const s = await ask();
  await confirmed(s, block([LABEL]), []);
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [other.id] });
  const [se2] = s.rt.sessionsIn(t2.id);
  s.rt.updateSession(se2.id, { confirms: [{ threadId: s.t.id, itemId: theConfirm(s).id, at: Date.now() }] });
  assert.deepEqual(await later({ ...s, t: t2 }, [call(LABEL)], se2), [false]);
});

test('#852 1a r2: a file the command names, edited after the click, gets the card', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const edit of [false, true]) {
    const s = await ask();
    const body = join(s.folder, 'body.md');
    await writeFile(body, 'The body you read.\n');
    const command = `cd ${s.folder} && gh pr edit 896 --repo o/r --body-file body.md`;
    await confirmed(s, block([command]), []);
    await until(() => !!theConfirm(s).answer.files);
    if (edit) await writeFile(body, 'Something else.\n');
    assert.deepEqual(await later(s, [call(command)]), [!edit], edit ? 'edited' : 'unchanged');
  }
});
