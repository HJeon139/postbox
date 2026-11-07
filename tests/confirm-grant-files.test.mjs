// #852 slice 1a r3: a confirmed command with a file or a push: the body file it posts, checked unchanged and for
// secrets Postbox knows, and a lone push, which Postbox makes. Helpers: tests/confirm-grant-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, block, call, confirmed, later, theConfirm } from './confirm-grant-fixture.mjs';
import { cards, lines, until } from './requested-setup.mjs';

test('#852 1a r3: a confirmed lone git push is made by Postbox, and the agent’s own is answered done', async () => {
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
  assert.deepEqual(await confirmed(s, block([push]), [call(push)]), ['denied'], 'the agent’s own push never runs: Postbox made it');
  assert.equal(made.length, 1, 'Postbox made it');
  assert.equal(lines(s)[0].push.branch, 'feat/now');
  assert.equal(cards(s).length, 0);
});
test('#852 1a r3: a file the command names, edited after the click, gets the card', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const edit of [false, true]) {
    const s = await ask();
    const body = join(s.folder, 'body.md');
    await writeFile(body, 'The body you read.\n');
    const command = `gh pr edit 896 --repo o/r --body-file ${body}`;
    await confirmed(s, block([command]), []);
    await until(() => !!theConfirm(s).answer.files);
    if (edit) await writeFile(body, 'Something else.\n');
    assert.deepEqual(await later(s, [call(command)]), [edit ? 'card' : 'ran'], edit ? 'edited' : 'unchanged');
  }
});
test('#852 1a r3: a secret Postbox knows, in the body file or the title, gets the card', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const key = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const s = await ask();
  const body = join(s.folder, 'body.md');
  await writeFile(body, `Token: ${key}\n`);
  const inFile = `gh pr edit 896 --repo o/r --body-file ${body}`;
  assert.deepEqual(await confirmed(s, block([inFile]), [call(inFile)]), ['card']);
  const t = await ask();
  const inTitle = `gh issue create --repo o/r --title "uses ${key}"`;
  assert.deepEqual(await confirmed(t, block([inTitle]), [call(inTitle)]), ['card']);
  assert.deepEqual([s.ran, t.ran], [[], []], 'nothing ran');
});

test('#852 1a r3: a body file changed between the confirm being shown and the click grants nothing', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { confirmBodies } = await import('../server/confirm-body.mjs');
  const s = await ask();
  const body = join(s.folder, 'body.md');
  await writeFile(body, 'What the person reads.\n');
  const command = `gh pr edit 896 --repo o/r --body-file ${body}`;
  const b = block([command]);
  s.next.push(async (c) => c.tools.show_block({ block: b }, await confirmBodies(s.rt, s.rt.sessionsIn(s.t.id)[0].id, 'show_block', { block: b })));
  s.rt.sendMessage(s.t.id, { text: 'Get it ready.' });
  await until(() => !s.rt.turns.size);
  // Shown; the file changes before the person clicks.
  await writeFile(body, 'Something else.\n');
  s.next.push(async (c) => c.text('ok'));
  await s.rt.act(s.t.id, theConfirm(s).id, 'confirm', {}, theConfirm(s).revision ?? 1);
  await until(() => !!theConfirm(s).answer.files && !s.rt.turns.size);
  assert.deepEqual(theConfirm(s).answer.files, {}, 'nothing recorded for it');
  assert.deepEqual(await later(s, [call(command)]), ['card']);
});
