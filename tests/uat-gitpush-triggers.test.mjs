// The gitpush scenario’s triggers (#305, #296). The cards are shaped as server/permission-cards.mjs writes them
// (askPerson’s kind, tool, detail and toolUseId; settlePermission’s status and answeredAt), the calls as a recorded
// stream gives them (a system init with its permissionMode, then the assistant’s tool_use), and the pushes as
// tools/uat/git-remote.mjs reads them from the remote’s reflog. They’re built here until the scenario’s first run
// records its own.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AUTO_PUSHES, GIT_PUSH_TRIGGERS, SCALE_PUSHES } from '../tools/uat/gitpush-triggers.mjs';

const T = 1_762_560_000_000;
const pushesAt = (n, from) => Array.from({ length: n }, (_, i) => ({ branch: 'main', sha: `${i}`.padStart(40, '0'), at: from + (i + 1) * 1000 }));
const card = (o) => ({ id: `it_${o.at}`, kind: 'permission', tool: 'Bash', handle: 'developer', toolUseId: null, ...o });
const facts = ({ items = [], pushes = [], samples = [], streams = [] }) => ({
  threads: ['th_main'],
  state: { items: { th_main: items } },
  remote: { pushes, gh: [], samples },
  streams,
});
const fired = (id, f) => GIT_PUSH_TRIGGERS[id].run(f);
/** One recorded turn in a permission mode, with these Bash calls. */
const turn = (mode, started, commands) => ({
  handle: 'developer',
  started,
  events: [
    { type: 'system', subtype: 'init', permissionMode: mode },
    {
      type: 'assistant',
      message: { content: commands.map((command, i) => ({ type: 'tool_use', id: `tu_${started}_${i}`, name: 'Bash', input: { command } })) },
    },
  ],
});

describe('push-card-landed', () => {
  test('a push with git’s own options before it is still a push: -c k=v and -C dir', () => {
    for (const detail of ['git -c user.name=UAT push origin work', 'git -C ../workspace push origin work']) {
      const items = [card({ at: T, detail, status: 'allowed', answeredAt: T + 500 })];
      assert.equal(fired('push-card-landed', facts({ items, pushes: pushesAt(1, T) })).length, 1, detail);
    }
  });
  test('fires for an allowed push card the remote took a push after', () => {
    const items = [card({ at: T, detail: 'git push origin main', status: 'allowed', answeredAt: T + 500 })];
    assert.equal(fired('push-card-landed', facts({ items, pushes: pushesAt(1, T) })).length, 1);
  });
  test('not for a denied card, nor with nothing on the remote', () => {
    const denied = [card({ at: T, detail: 'git push', status: 'denied', answeredAt: T + 500 })];
    assert.deepEqual(fired('push-card-landed', facts({ items: denied, pushes: pushesAt(1, T) })), []);
    const allowed = [card({ at: T, detail: 'git push', status: 'allowed', answeredAt: T + 500 })];
    assert.deepEqual(fired('push-card-landed', facts({ items: allowed })), []);
  });
});

describe('always-allow-no-card', () => {
  const always = card({ at: T, detail: 'git push origin main', status: 'allowed-always', answeredAt: T + 500 });
  test('fires once three pushes landed after the one Always allow let through, with no card since', () => {
    assert.equal(fired('always-allow-no-card', facts({ items: [always], pushes: pushesAt(4, T + 500) })).length, 1);
  });
  test('not when only the push that had the card and two more landed', () => {
    assert.deepEqual(fired('always-allow-no-card', facts({ items: [always], pushes: pushesAt(3, T + 500) })), []);
  });
  test('not when a push came to a card again after it', () => {
    const again = card({ at: T + 2500, detail: 'git push', status: 'open' });
    assert.deepEqual(fired('always-allow-no-card', facts({ items: [always, again], pushes: pushesAt(4, T + 500) })), []);
  });
  test('not with only two pushes after it, nor after Allow once', () => {
    assert.deepEqual(fired('always-allow-no-card', facts({ items: [always], pushes: pushesAt(2, T + 500) })), []);
    assert.deepEqual(fired('always-allow-no-card', facts({ items: [{ ...always, status: 'allowed' }], pushes: pushesAt(5, T + 500) })), []);
  });
});

describe('pushes-at-scale', () => {
  const sample = (ledgerPushes) => ({ at: T, pushes: SCALE_PUSHES, entries: 90, ledgerPushes, ledgerBytes: 41_000, stateBytes: 230_000 });
  test(`fires at ${SCALE_PUSHES} pushes with a ledger entry for each, and says the sizes`, () => {
    const [hit] = fired('pushes-at-scale', facts({ pushes: pushesAt(SCALE_PUSHES, T), samples: [sample(SCALE_PUSHES)] }));
    assert.match(hit.evidence, /20 pushes on the remote; the ledger has 20 push entries of 90 \(41000 bytes\), and the state is 230000 bytes/);
  });
  test('not when the ledger missed a push, nor one push short', () => {
    assert.deepEqual(fired('pushes-at-scale', facts({ pushes: pushesAt(SCALE_PUSHES, T), samples: [sample(SCALE_PUSHES - 1)] })), []);
    assert.deepEqual(fired('pushes-at-scale', facts({ pushes: pushesAt(SCALE_PUSHES - 1, T), samples: [sample(SCALE_PUSHES)] })), []);
  });
});

describe('auto-writes-no-card', () => {
  const pushes = Array.from({ length: AUTO_PUSHES }, () => 'git push origin main');
  const streams = [turn('auto', T, [...pushes, 'gh pr create --title "Change" --body "Why."'])];
  test(`fires for ${AUTO_PUSHES} pushes in Auto and a PR write, none of them carded`, () => {
    const [hit] = fired('auto-writes-no-card', facts({ streams, pushes: pushesAt(AUTO_PUSHES, T) }));
    assert.match(hit.evidence, /In Auto, 10 pushes landed and 1 PR writes ran, with no card for any of 11 write calls/);
  });
  test('not when one of those calls came to a card, as the sixth requested call in a turn does', () => {
    const items = [card({ at: T + 6000, detail: 'git push origin main', status: 'open', toolUseId: `tu_${T}_5` })];
    assert.deepEqual(fired('auto-writes-no-card', facts({ streams, items, pushes: pushesAt(AUTO_PUSHES, T) })), []);
  });
  test('not for the same calls in Ask me, nor with no PR write', () => {
    const ask = [turn('manual', T, [...pushes, 'gh pr create --title x'])];
    assert.deepEqual(fired('auto-writes-no-card', facts({ streams: ask, pushes: pushesAt(AUTO_PUSHES, T) })), []);
    assert.deepEqual(fired('auto-writes-no-card', facts({ streams: [turn('auto', T, pushes)], pushes: pushesAt(AUTO_PUSHES, T) })), []);
  });
  test('a card for a call in another turn doesn’t count against it', () => {
    const items = [card({ at: T - 9000, detail: 'git push', status: 'allowed', toolUseId: 'tu_earlier_0' })];
    assert.equal(fired('auto-writes-no-card', facts({ streams, items, pushes: pushesAt(AUTO_PUSHES, T) })).length, 1);
  });
});
