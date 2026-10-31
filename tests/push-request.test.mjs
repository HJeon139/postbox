// #296, the review of #562: a git push the person asked for is never the agent’s own. Postbox makes the push itself,
// to the repository the person set on the project, and the agent’s call answers no with what landed where. Here the
// push’s reading and running answer as told (rt.pushes); tests/process/push-on-request.test.mjs runs git for real.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allow, asking, bash, cards, lines, setup, until } from './requested-setup.mjs';

/** A Postbox push that answers as told: what it would do, and how making it went. */
function pushes(s, { url = 'https://github.com/HJeon139/postbox.git', ran = { ok: true } } = {}) {
  const sentence = `commit aaaaaaa lands on branch feat/now of ${url}, with no force`;
  const seen = { asked: [], made: [] };
  s.rt.pushes = {
    consequence: async (o) => {
      seen.asked.push(o);
      return o.url ? { branch: 'feat/now', current: 'feat/now', sha: 'a'.repeat(40), objects: '/x', url: o.url, sentence } : null;
    },
    run: async (p) => {
      seen.made.push(p);
      return ran;
    },
  };
  s.store.emit('project', { ...s.store.state.projects.p1, pushUrl: url });
  return seen;
}
/** One call in a turn the person’s message starts, and the agent’s answer: a card is answered no. */
async function answerTo(s, text, req) {
  const answers = [];
  s.next.push(asking(s, [req], answers));
  s.rt.sendMessage(s.t.id, { text });
  await until(() => answers.length && !s.rt.turns.size);
  return answers[0];
}

test('#562: a push the person asked for is Postbox’s own; the agent’s git push answers no, saying what landed where', async () => {
  const s = await setup({ judged: () => allow('push it to origin') });
  const seen = pushes(s);
  const answer = await answerTo(s, 'Commit the fix and push it to origin.', bash('git push -u origin feat/now'));
  assert.equal(answer.allow, false);
  assert.match(
    answer.message,
    /^Postbox pushed this for you, as the person asked: commit aaaaaaa is now on branch feat\/now of https:\/\/github\.com\/HJeon139\/postbox\.git\. Your own git push didn’t run/,
  );
  assert.equal(cards(s).length, 0);
  assert.equal(seen.made.length, 1);
  assert.deepEqual(
    [seen.asked[0].url, seen.asked[0].push, seen.asked[0].named],
    ['https://github.com/HJeon139/postbox.git', { branch: 'feat/now' }, 'commit the fix and push it to origin.'],
  );
  assert.match(
    s.prompts[0],
    /Postbox would make this push for the agent: commit aaaaaaa lands on branch feat\/now of https:\/\/github\.com\/HJeon139\/postbox\.git, with no force\./,
  );
  const [line] = lines(s);
  assert.deepEqual([line.status, line.quote, line.push.branch, line.push.error], ['allowed', 'push it to origin', 'feat/now', null]);
  const pushed = (s.rt.s.work?.[s.rt.ledger.convOf(s.t.id)] ?? []).filter((e) => e.kind === 'push');
  assert.deepEqual(
    pushed.map((e) => [e.branch, e.remote]),
    [['feat/now', 'https://github.com/HJeon139/postbox.git']],
    'on the work ledger',
  );
});

test('#562: a push gets the card when Postbox’s own push fails, with no repository set, or in a chain', async () => {
  const failed = await setup({ judged: () => allow('push it to origin') });
  pushes(failed, { ran: { ok: false, error: 'remote: Permission denied' } });
  assert.equal((await answerTo(failed, 'Push it to origin.', bash('git push'))).allow, false);
  assert.equal(cards(failed).length, 1, 'it asks the person instead');
  assert.deepEqual([lines(failed)[0].status, lines(failed)[0].push.error], ['failed', 'remote: Permission denied']);
  const unset = await setup({ judged: () => allow('push it to origin') });
  const seen = pushes(unset, { url: '' });
  await answerTo(unset, 'Push it to origin.', bash('git push'));
  assert.deepEqual([cards(unset).length, seen.made.length, unset.prompts.length], [1, 0, 0]);
  const chain = await setup({ judged: () => allow('commit and push it') });
  const chained = pushes(chain);
  await answerTo(chain, 'Commit and push it.', bash('git add -A && git commit -m x && git push'));
  assert.deepEqual([cards(chain).length, chained.asked.length, chain.prompts.length], [1, 0, 0]);
});
