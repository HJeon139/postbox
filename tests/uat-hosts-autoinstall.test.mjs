// A host with an older Postbox staged on it that Postbox updates by itself (#464): the runner turns the host’s consent
// on through the page after staging, the run keeps each install try from the host’s status events, the trigger
// that reads one install of this run’s version followed by a turn there, and the check that a try never repeats.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostStateOf } from '../tools/uat/history.mjs';
import { createHostRun, followStatuses, setUpHost } from '../tools/uat/hosts-run.mjs';

const RUNS = '1.17.0';
/** A host status event as the run keeps it (hostStateOf), arriving at `at`, with its newest install try. */
const status = (at, outcome, { id = 'ho_1', version = RUNS, tried = 5000, state = 'disconnected' } = {}) => ({
  at,
  id,
  state,
  failure: null,
  update: outcome ? { version, at: tried, outcome } : null,
});
test('#464 hostStateOf keeps the newest install try’s version, time and outcome, never its error', () => {
  const d = {
    id: 'ho_1',
    status: { state: 'not-installed', failure: { kind: 'not-installed' }, update: { version: RUNS, at: 5000, outcome: 'failed', error: 'ssh said x' } },
  };
  assert.deepEqual(hostStateOf(d), { id: 'ho_1', state: 'not-installed', failure: 'not-installed', update: { version: RUNS, at: 5000, outcome: 'failed' } });
  assert.equal(hostStateOf({ id: 'ho_1', status: { state: 'connected' } })?.update, null, 'no try yet');
});

/** A host run on host1 with an older Postbox to stage, set up with these steps of the UI. */
async function setUpStaged(ui) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-auto-'));
  const lines = [];
  const hr = createHostRun({
    hosts: [{ label: 'host1', destination: 'host-a.example.com', settings: {}, stage: { tag: 'v1.16.1', version: '1.16.1' } }],
    placement: { researcher: 'host1' },
    launcher: null,
    root: '/repo',
    stamp: '20261104-1200',
    data: join(dir, 'data'),
    log: (l) => lines.push(l),
  });
  const order = [];
  const steps = {
    addHost: async () => 'ho_1',
    makeRunFolder: async () => {},
    editHost: async () => {},
    install: async () => assert.fail('the UI’s Install isn’t used on a staged host'),
    stage: async () => order.push('stage'),
    version: () => RUNS,
    ...ui(order),
  };
  try {
    await setUpHost(hr, hr.hosts[0], 'pr_1', steps);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { hr, order, lines };
}

test('#464 a staged host gets its consent to install by itself through the page, after the staging, and the setup says so', async () => {
  const { hr, order, lines } = await setUpStaged((order) => ({
    keepUpdated: async (_kit, id) => {
      order.push(`consent ${id}`);
      return true;
    },
  }));
  assert.deepEqual(order, ['stage', 'consent ho_1'], 'the consent comes once the older version is there');
  assert.equal(hr.record.setup[0].consent, true);
  assert.equal(hr.record.setup[0].runVersion, RUNS, 'the version Postbox installs by itself');
  assert.doesNotMatch(JSON.stringify(hr.record.setup) + lines.join('\n'), /example\.com|\/repo/, 'no destination or path');
});

test('#464 a consent the page’s request didn’t keep stops the run’s setup, saying so', async () => {
  await assert.rejects(
    setUpStaged(() => ({ keepUpdated: async () => false })),
    /host1’s consent to install Postbox by itself wasn’t kept/,
  );
});

test('#464 an unstaged host gets no consent from the runner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-auto-'));
  const hr = createHostRun({
    hosts: [{ label: 'host1', destination: 'host-a.example.com', settings: {} }],
    placement: {},
    launcher: null,
    root: '/repo',
    stamp: '20261104-1200',
    data: join(dir, 'data'),
    log: () => {},
  });
  await setUpHost(hr, hr.hosts[0], 'pr_1', {
    addHost: async () => 'ho_1',
    makeRunFolder: async () => {},
    editHost: async () => {},
    install: async () => ({ installOffered: true, confirm: 'Install?' }),
    keepUpdated: async () => assert.fail('no consent for a host the run installs itself'),
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(hr.record.setup[0].consent, undefined);
});

test('#464 the run’s record of its hosts keeps the status events as they come, for the triggers and --recheck', () => {
  const seen = [status(4000, null)];
  const hr = createHostRun({ hosts: [], placement: {}, launcher: null, root: '/repo', stamp: 's', data: '/tmp/x', log: () => {} });
  followStatuses(hr, () => seen);
  seen.push(status(5001, 'started'));
  assert.deepEqual(hr.record.statuses, seen, 'one that came after is there too');
  assert.equal(hr.hostStates?.(), seen, 'the faults and the setup read the same');
});
