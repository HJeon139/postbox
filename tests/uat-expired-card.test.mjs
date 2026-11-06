// The host trigger expired-card-no-need (#721, tools/uat/triggers-host.mjs): a permission card from a host that
// expired unanswered, whose agent no longer needs you for it. The facts are the shapes a host-mode run records: the
// runner’s hosts, the conversation’s items and the sessions, as Postbox’s state holds them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triggersFired } from '../tools/uat/triggers.mjs';

const ID = 'expired-card-no-need';
/** A host run whose @critic on host2 had a card expire, needing you for `needs` afterwards. */
const facts = (needs) => ({
  hosts: { hosts: [{ id: 'ho_2', label: 'host2', destination: 'host2.example.com' }], placement: { critic: 'host2' } },
  threads: ['t1'],
  state: {
    items: {
      t1: [
        {
          id: 'it_perm',
          kind: 'permission',
          sessionId: 'se_critic',
          handle: 'critic',
          tool: 'Bash',
          summary: 'run date >> expiry-check.txt',
          remote: { hostId: 'ho_2', turn: 'ht_1', prompt: 'prompt-1' },
          status: 'expired',
          agentTold: true,
          at: 10_000,
          answeredAt: 70_000,
        },
      ],
    },
    sessions: { se_critic: { id: 'se_critic', handle: 'critic', state: needs ? 'needs' : 'idle', needs } },
  },
});

test('#721 expired-card-no-need fires for an expired card its agent no longer needs you for, naming both', () => {
  const fired = triggersFired(facts(null), [ID])[ID];
  assert.ok(fired, 'it fires');
  assert.match(fired.evidence, /@critic’s card it_perm “run date >> expiry-check\.txt” expired/);
  assert.equal(fired.at, 70_000);
});

test('#721 expired-card-no-need stays silent while the ring still needs you for the expired card', () => {
  const needs = { kind: 'permission', itemId: 'it_perm', text: '@critic asks to run date' };
  assert.equal(triggersFired(facts(needs), [ID])[ID], false);
});

test('#721 expired-card-no-need stays silent for a card that was answered, and can’t tell in a run without hosts', () => {
  const answered = facts(null);
  answered.state.items.t1[0].status = 'allowed';
  assert.equal(triggersFired(answered, [ID])[ID], false);
  const here = { ...facts(null), hosts: undefined };
  assert.equal(triggersFired(here, [ID])[ID], null);
});

test('#721 expired-card-no-need stays silent for an expired card its agent was never told about, as on main', () => {
  const untold = facts(null);
  delete untold.state.items.t1[0].agentTold;
  assert.equal(triggersFired(untold, [ID])[ID], false);
});

test('#721 expired-card-no-need fires for a card its host ended, which the agent is told about too', () => {
  const ended = facts(null);
  ended.state.items.t1[0].status = 'ended';
  assert.ok(triggersFired(ended, [ID])[ID]);
});
