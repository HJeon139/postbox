// #296: a gh write the person already approved in a block runs without a second card, within limits Postbox enforces.
// The cases follow the room in #296’s 30 October comment (the “Agent research” room, Postbox 0.44.1 to 0.44.7): the
// person confirmed a push and a PR in a block, and the agent’s gh pr create then waited on a card for the same call.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { APPROVED_WRITES_MAX, covers, ghCall, shellWords } from '../server/write-intent.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(5);
};

const TITLE = 'feat(now): what each agent is doing now';
const CONFIRM = {
  id: 'push',
  type: 'confirm',
  version: 1,
  fallback: 'Push and open the PR?',
  title: 'Push Now and open its PR',
  statement: `Push feat/now (2d7c9a65) to origin and open “${TITLE}” against main. It closes #508.`,
  confirmLabel: 'Push 2d7c9a65',
};
const ghCreate = (extra = '') => ({
  tool: 'Bash',
  summary: 'run gh pr create',
  input: { command: `gh pr create --title "${TITLE}"${extra} --body "$(cat <<'EOF'\n## Why\n\nNow shows what each agent is doing.\nEOF\n)"` },
});
const bash = (command) => ({ tool: 'Bash', summary: 'run a command', input: { command } });

/** A Claude Code agent whose turns the test scripts, working in a temp folder. */
async function setup(persona = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pb-approved-'));
  const folder = join(root, 'work');
  await mkdir(join(folder, '.claude'), { recursive: true });
  const store = new Store(null);
  const next = [];
  const adapter = {
    name: 'claude-code',
    folderFor: async () => folder,
    async deliver(_s, _m, ctx) {
      await (next.shift() ?? (async (c) => c.text('ok')))(ctx);
    },
  };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'now', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'], ...persona });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { rt, store, t, p, next };
}

/** The agent shows a block and its turn ends; the person answers it, which starts the turn `then` scripts. */
async function approve({ rt, store, t, next }, block, then, answer = ['confirm', {}]) {
  next.push(async (c) => c.tools.show_block({ block }));
  rt.sendMessage(t.id, { text: 'Get Now ready to merge.' });
  await until(() => !rt.turns.size);
  const it = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === block.id);
  next.push(then);
  await rt.act(t.id, it.id, ...answer);
  await until(() => !rt.turns.size);
  return it;
}
const cards = (store, t) => store.items(t.id).filter((i) => i.kind === 'permission');
const lines = (store, t) => store.items(t.id).filter((i) => i.kind === 'allowedwrite');

test('a gh pr create the confirmed block names runs without a card, and leaves a line saying what the person confirmed', async () => {
  const s = await setup();
  const answers = [];
  await approve(s, CONFIRM, async (c) => answers.push(await c.askPermission(ghCreate())));
  assert.deepEqual(answers, [{ allow: true }]);
  assert.equal(cards(s.store, s.t).length, 0);
  const [line] = lines(s.store, s.t);
  assert.deepEqual([line.what, line.handle, line.verb, line.approved, line.status], ['gh pr create', 'now', 'confirmed', 'Push 2d7c9a65', 'allowed']);
});

test('an approved review covers the PR its draft names', async () => {
  const s = await setup();
  const answers = [];
  const review = {
    id: 'draft',
    type: 'review',
    version: 1,
    fallback: 'The PR body',
    title: 'The PR for Now',
    format: 'markdown',
    content: `# ${TITLE}\n\nNow shows what each agent is doing.`,
  };
  await approve(s, review, async (c) => answers.push(await c.askPermission(ghCreate())), ['submit', { verdict: 'approve', comments: [] }]);
  assert.deepEqual(answers, [{ allow: true }]);
  assert.deepEqual(
    lines(s.store, s.t).map((l) => [l.verb, l.approved]),
    [['approved', 'The PR for Now']],
  );
});

test('writes the approval doesn’t cover still get a card: another repository, a label, a title it doesn’t name, a command with more in it', async () => {
  for (const req of [
    ghCreate(' --repo someone/else'),
    bash('gh pr edit 508 --add-label P0'),
    bash('gh pr create --title "Something else entirely" --body x'),
    bash(`gh pr create --title "${TITLE}" --body x; rm -rf build`),
    bash(`gh pr create --title "${TITLE}" --body "$(git log -1 --format=%B)"`),
    bash('gh pr comment feat/now --body "Ready."'),
  ]) {
    const s = await setup();
    let answer = null;
    await approve(s, CONFIRM, async (c) => {
      const asked = c.askPermission(req);
      await until(() => cards(s.store, s.t).length);
      await s.rt.act(s.t.id, cards(s.store, s.t)[0].id, 'deny', {});
      answer = await asked;
    });
    assert.equal(cards(s.store, s.t).length, 1, req.input.command);
    assert.equal(answer?.allow, false, req.input.command);
    assert.equal(lines(s.store, s.t).length, 0, req.input.command);
  }
});

test('a turn the person’s typed message started, a declined confirm and a persona that turned it off all get the card', async () => {
  const typed = await setup();
  typed.next.push(async (c) => {
    c.askPermission(ghCreate());
    await until(() => cards(typed.store, typed.t).length);
  });
  typed.rt.sendMessage(typed.t.id, { text: `Open “${TITLE}”.` });
  await until(() => cards(typed.store, typed.t).length);
  assert.equal(cards(typed.store, typed.t).length, 1);
  for (const [s, answer] of [
    [await setup(), ['cancel', {}]],
    [await setup({}), ['confirm', {}]],
  ]) {
    if (answer[0] === 'confirm') s.rt.updatePersona(s.p.id, { writesAsApproved: false });
    await approve(
      s,
      CONFIRM,
      async (c) => {
        c.askPermission(ghCreate());
        await until(() => cards(s.store, s.t).length);
      },
      answer,
    );
    assert.equal(cards(s.store, s.t).length, 1, answer[0]);
    assert.equal(lines(s.store, s.t).length, 0, answer[0]);
  }
});

test('Stop on the line ends the approval: the agent’s next write in that turn gets a card', async () => {
  const s = await setup();
  const answers = [];
  await approve(s, CONFIRM, async (c) => {
    answers.push(await c.askPermission(ghCreate()));
    await s.rt.act(s.t.id, lines(s.store, s.t)[0].id, 'stop', {});
    const asked = c.askPermission(bash('gh pr comment 508 --body "Pushed."'));
    await until(() => cards(s.store, s.t).length);
    await s.rt.act(s.t.id, cards(s.store, s.t)[0].id, 'deny', {});
    answers.push(await asked);
  });
  assert.deepEqual(
    answers.map((a) => a.allow),
    [true, false],
  );
  assert.equal(lines(s.store, s.t)[0].status, 'stopped');
  assert.ok(s.store.items(s.t.id).some((i) => i.kind === 'voice' && i.text === 'Stopped: @now’s next write outside Postbox asks you first'));
});

test(`one approval lets ${APPROVED_WRITES_MAX} writes through, and the next gets a card`, async () => {
  const s = await setup();
  const answers = [];
  await approve(s, CONFIRM, async (c) => {
    for (let i = 0; i < APPROVED_WRITES_MAX; i++) answers.push(await c.askPermission(bash(`gh pr comment 508 --body "Step ${i}."`)));
    c.askPermission(bash('gh pr comment 508 --body "One more."'));
    await until(() => cards(s.store, s.t).length);
  });
  assert.deepEqual(
    answers.map((a) => a.allow),
    Array(APPROVED_WRITES_MAX).fill(true),
  );
  assert.equal(lines(s.store, s.t).length, APPROVED_WRITES_MAX);
  assert.equal(cards(s.store, s.t).length, 1);
});

test('a comment on the PR this conversation opened is covered, though the block didn’t name its number', async () => {
  const s = await setup();
  const answers = [];
  const url = 'https://github.com/HJeon139/postbox/pull/537';
  await approve(s, CONFIRM, async (c) => {
    answers.push(await c.askPermission(ghCreate()));
    c.toolUse({ id: 'toolu_pr', name: 'Bash', input: ghCreate().input });
    c.toolResult({ id: 'toolu_pr', isError: false, text: url, result: { stdout: `${url}\n` } });
    await until(() => (s.store.state.work?.[s.t.id] ?? []).some((e) => e.kind === 'external'));
    answers.push(await c.askPermission(bash('gh pr comment 537 --body "CI is green."')));
    answers.push(await c.askPermission(bash(`gh pr edit ${url} --body "Now, with tests."`)));
  });
  assert.deepEqual(
    answers.map((a) => a.allow),
    [true, true, true],
  );
  assert.equal(cards(s.store, s.t).length, 0);
});

test('a gh write is read as the shell would, and one an approval can’t cover is null', () => {
  assert.deepEqual(shellWords(`gh pr create --title "a \\"b\\"" -b 'c d'`), ['gh', 'pr', 'create', '--title', 'a "b"', '-b', 'c d']);
  assert.deepEqual(shellWords('gh pr create --title "unclosed'), [], 'an unclosed quote reads as nothing, which nothing covers');
  assert.deepEqual(ghCall(`gh pr create --title=${JSON.stringify(TITLE)} --draft --base main`), {
    what: 'gh pr create',
    values: { title: TITLE, '--base': 'main' },
    target: null,
  });
  for (const part of [
    'gh pr merge 12',
    'gh pr review 12 --approve',
    'gh release create v1',
    'gh pr create --title x --reviewer someone',
    'gh pr comment 12 --delete-last',
    'gh pr comment --body x',
    'gh pr create --title',
  ])
    assert.equal(ghCall(part), null, part);
});

test('the block’s words cover a call only by its whole title, its number or its link', () => {
  const words = `${CONFIRM.title}\n${CONFIRM.statement}`;
  const none = { urls: [], numbers: [] };
  assert.ok(covers(ghCall(`gh pr create --title "${TITLE.toUpperCase()}"`), words, none), 'case doesn’t matter');
  assert.ok(!covers(ghCall('gh pr create --title "Push Now"'), words, none), 'a short title could turn up anywhere');
  assert.ok(covers(ghCall('gh issue comment 508 --body x'), words, none));
  assert.ok(!covers(ghCall('gh issue comment 50 --body x'), words, none), '#50 isn’t #508');
  assert.ok(!covers(ghCall('gh issue comment https://github.com/someone/else/issues/508 --body x'), words, none), 'a link names its own repository');
  assert.ok(covers(ghCall('gh issue comment 9 --body x'), words, { urls: [], numbers: ['9'] }));
  assert.ok(!covers(ghCall('gh issue comment 9 --repo someone/else --body x'), words, { urls: [], numbers: ['9'] }));
});
