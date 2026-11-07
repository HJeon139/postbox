// Grant once (#852): after the person’s “Allow always in this room” on one card, the same shape of git push or gh call
// from that agent in that room passes with no card, made by Postbox, and judged afresh each time; anything else still
// gets the card. Packet: sprint4/grant-once-packet-r1.md (v3) with its r2 delta.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import { cards, lines } from './requested-setup.mjs';
import { call, gitFolder, granting, REPO_URL, SHA_A, SHA_B, saveRule, turn } from './room-grants-fixture.mjs';

const PUSH_A = 'git push origin feat/a';
const PUSH_B = 'git push origin feat/b';
const LABEL_1 = 'gh pr edit 940 --repo o/r --add-label P1';
const LABEL_2 = 'gh pr edit 941 --repo o/r --add-label P2';

test('grant once: Allow always in this room on a push, then a push of another branch passes, made by Postbox', async () => {
  const s = await granting();
  assert.deepEqual(await turn(s, [call(PUSH_A)], { answer: 'room' }), ['card:room']);
  assert.deepEqual(cards(s)[0].roomGrant.shape, 'git push');
  assert.deepEqual(await turn(s, [call(PUSH_B)]), ['pushed']);
  assert.deepEqual(s.pushed, [{ branch: 'feat/b', sha: SHA_B, url: REPO_URL, lease: null }]);
  assert.equal(cards(s).length, 1, 'only the first card');
  const [line] = lines(s);
  assert.deepEqual([line.how, line.granted, line.detail], ['granted', 'git push', PUSH_B]);
});

test('grant once: a gh shape, on another PR, runs with exactly its words', async () => {
  const s = await granting();
  await turn(s, [call(LABEL_1)], { answer: 'room' });
  assert.deepEqual(await turn(s, [call(LABEL_2)]), ['ran']);
  assert.deepEqual(s.ran, [['pr', 'edit', '941', '--repo', 'o/r', '--add-label', 'P2']]);
  assert.equal(cards(s).length, 1);
});

test('grant once: the rule survives a restart, read from the store', async () => {
  const s = await granting();
  await turn(s, [call(PUSH_A)], { answer: 'room' });
  const rt = new Runtime({
    store: s.store,
    adapters: s.rt.adapters,
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: s.folder },
  });
  rt.pushes = s.rt.pushes;
  assert.deepEqual(await turn({ ...s, rt }, [call(PUSH_B)]), ['pushed']);
});

test('grant once: another agent, another room, a subagent and an unbound prompt each get a card', async () => {
  const s = await granting();
  saveRule(s, 'git push');
  const other = s.rt.createPersona({ handle: 'other', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t2 = s.rt.createThread({ projectId: 'p1', title: 'Other room', personaIds: [s.p.id] });
  assert.deepEqual(await turn({ ...s, t: t2 }, [call(PUSH_B)], { session: s.rt.sessionsIn(t2.id)[0] }), ['card'], 'another room');
  assert.deepEqual(await turn(s, [call(PUSH_B, { agentId: 'sub_1' })]), ['card'], 'a subagent');
  assert.deepEqual(await turn(s, [call(PUSH_B, { bound: false })]), ['card'], 'unbound');
  const t3 = s.rt.createThread({ projectId: 'p1', title: 'Its room', personaIds: [other.id] });
  saveRule({ ...s, t: t3 }, 'git push', { threadId: t3.id });
  assert.deepEqual(await turn({ ...s, t: t3 }, [call(PUSH_B)], { session: s.rt.sessionsIn(t3.id)[0] }), ['card'], 'another agent’s rule');
});

test('grant once: never the default branch, by name or as the remote says; a card when it can’t be learned', async () => {
  const trunk = await granting({ main: 'feat/b' });
  saveRule(trunk, 'git push');
  assert.deepEqual(await turn(trunk, [call(PUSH_B)]), ['card'], 'the remote’s default');
  const unknown = await granting({ main: null });
  saveRule(unknown, 'git push');
  assert.deepEqual(await turn(unknown, [call(PUSH_B)]), ['card'], 'unknown default');
  // main and master are refused by name, even where the remote names another default and both exist here.
  const named = await granting({ main: 'trunk' });
  await gitFolder(named.folder, { 'feat/a': SHA_A, main: SHA_A, master: SHA_B });
  saveRule(named, 'git push');
  assert.deepEqual(await turn(named, [call('git push origin main'), call('git push origin master')]), ['card', 'card']);
});

test('grant once: a lease only as <branch>:<sha> on the same branch, and the push carries it', async () => {
  const s = await granting();
  saveRule(s, 'git push');
  const lease = `git push --force-with-lease=feat/b:${SHA_A} origin feat/b`;
  const bare = 'git push --force-with-lease origin feat/b';
  const other = `git push --force-with-lease=feat/a:${SHA_A} origin feat/b`;
  assert.deepEqual(await turn(s, [call(lease), call(bare), call(other), call('git push -f origin feat/b')]), ['pushed', 'card', 'card', 'card']);
  assert.equal(s.pushed[0].lease, SHA_A);
});

test('grant once: a chain, a prefix or another shape gets the card under a push rule', async () => {
  const s = await granting();
  saveRule(s, 'git push');
  const answers = await turn(s, [call(`git fetch && ${PUSH_B}`), call(`FOO=1 ${PUSH_B}`), call(LABEL_1)]);
  assert.deepEqual(answers, ['card', 'card', 'card']);
});

test('grant once: a body file gets the card until the person says otherwise; the integrator’s label always does', async () => {
  const s = await granting();
  saveRule(s, 'gh pr comment');
  saveRule(s, 'gh pr edit');
  // A real file in the agent’s own folder, which the scan finds clean: only the person’s choice keeps its card.
  const body = join(s.folder, 'body.md');
  await writeFile(body, 'CI is green.\n');
  const comment = call(`gh pr comment 940 --repo o/r --body-file ${body}`);
  const reserved = call('gh pr edit 940 --repo o/r --add-label "ready for integrator"');
  assert.deepEqual(await turn(s, [comment, reserved]), ['card', 'card']);
  assert.deepEqual(s.ran, []);
});

test('grant once: Remove in the panel, and Stop on a line it made, each take the rule away', async () => {
  const s = await granting();
  const grant = saveRule(s, 'git push');
  assert.deepEqual(await turn(s, [call(PUSH_B)]), ['pushed']);
  await s.rt.act(s.t.id, lines(s)[0].id, 'stop', {});
  assert.deepEqual(await turn(s, [call(PUSH_B)]), ['card'], 'after Stop');
  saveRule(s, 'git push');
  const se = s.rt.sessionsIn(s.t.id)[0];
  await s.rt.changePermissionRule({ where: 'room', sessionId: se.id, grantId: grant.id });
  assert.deepEqual(await turn(s, [call(PUSH_B)]), ['card'], 'after Remove');
});

test('grant once: the 11th granted call in one turn gets the card', async () => {
  const s = await granting();
  saveRule(s, 'gh pr edit');
  const reqs = Array.from({ length: 11 }, (_, i) => call(`gh pr edit ${900 + i} --repo o/r --add-label P2`));
  const answers = await turn(s, reqs);
  assert.deepEqual(answers.slice(0, 10), Array(10).fill('ran'));
  assert.equal(answers[10], 'card');
});

test('grant once: a rule of a deleted persona never applies to a new one with its handle', async () => {
  const s = await granting();
  saveRule(s, 'git push', { personaId: 'pe_gone' });
  assert.deepEqual(await turn(s, [call(PUSH_B)]), ['card']);
});

test('grant once: another repository gets the card', async () => {
  const s = await granting();
  saveRule(s, 'gh pr edit');
  assert.deepEqual(await turn(s, [call('gh pr edit 940 --repo o/other --add-label P1')]), ['card']);
});

test('grant once: a label the privacy scan flags gets the card, and nothing runs', async () => {
  const s = await granting();
  saveRule(s, 'gh pr edit');
  assert.deepEqual(await turn(s, [call(`gh pr edit 940 --repo o/r --add-label ghp_${'a'.repeat(36)}`)]), ['card']);
  assert.deepEqual(s.ran, []);
});

test('grant once: cd or -C into a folder of another repository gets the card', async () => {
  const s = await granting();
  saveRule(s, 'git push');
  const elsewhere = join(s.folder, '..', 'elsewhere');
  await gitFolder(elsewhere, { 'feat/b': SHA_B });
  const answers = await turn(s, [call(`cd ${elsewhere} && ${PUSH_B}`), call(`git -C ${elsewhere} ${PUSH_B.slice(4)}`), call(`cd ${s.folder} && ${PUSH_B}`)]);
  assert.deepEqual(answers, ['card', 'card', 'pushed']);
});

test('grant once: a rule saved on a host card never applies to a local turn', async () => {
  const s = await granting();
  saveRule(s, 'git push', { hostId: 'ho_1' });
  assert.deepEqual(await turn(s, [call(PUSH_B)]), ['card']);
});

test('grant once: a card for a call with a body file offers no room rule, since its body file always asks', async () => {
  const s = await granting();
  const answers = await turn(s, [call('gh pr comment 940 --repo o/r --body-file /tmp/pb-x/b.md'), call(LABEL_1)]);
  assert.deepEqual(answers, ['card', 'card']);
  assert.deepEqual(
    cards(s).map((c) => c.roomGrant?.shape ?? null),
    [null, 'gh pr edit'],
  );
});
