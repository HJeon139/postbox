// A host with an older Postbox staged on it that Postbox updates by itself (#464): the runner turns the host’s consent
// on through the page after staging, the run keeps each install try from the host’s status events, the trigger
// that reads one install of this run’s version followed by a turn there, and the check that a try never repeats.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { hostStateOf } from '../tools/uat/history.mjs';
import { createHostRun, followStatuses, setUpHost } from '../tools/uat/hosts-run.mjs';
import { HOST_TRIGGERS } from '../tools/uat/triggers-host.mjs';
import { facts, remote } from './uat-hosts-facts.mjs';

const trigger = HOST_TRIGGERS['host-auto-installed'];
const RUNS = '1.17.0';
/** A host status event as the run keeps it (hostStateOf), arriving at `at`, with its newest install try. */
const status = (at, outcome, { id = 'ho_1', version = RUNS, tried = 5000, state = 'disconnected' } = {}) => ({
  at,
  id,
  state,
  failure: null,
  update: outcome ? { version, at: tried, outcome } : null,
});
/** One automatic install of this run’s version on host1: started, then installed. */
const once = () => [status(4000, null), status(5001, 'started'), status(6000, 'installed'), status(6500, 'installed', { state: 'connected' })];

/**
 * host1 staged with an older Postbox, its consent on, these statuses, and @researcher’s turns there: the first failed
 * as not installed before the install, and the second, at 7000, ran there after it.
 */
function installed({ statuses = once(), setup = {}, second = {} } = {}) {
  const f = facts();
  f.hosts.setup = [{ label: 'host1', staged: '1.16.1', stagedAt: 1000, runVersion: RUNS, consent: true, notInstalled: 3000, ...setup }];
  f.hosts.statuses = statuses;
  const turn = { id: 'i4', kind: 'agent', handle: 'researcher', sessionId: 's1', turnId: 'tu_r2', status: 'done', at: 7000, ...second };
  f.state.items.t1 = [{ ...f.state.items.t1[0], status: 'error', at: 2500 }, ...f.state.items.t1.slice(1), turn];
  f.events.push({ seq: 9, type: 'session', data: { id: 's1', state: 'gen', remoteTurn: remote(second.host ?? 'ho_1', 'tu_r2', 'h-2') } });
  return f;
}

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

test('#464 host-auto-installed fires when a staged host installed this run’s version once, and a turn then ran there', () => {
  const hits = trigger.run(installed());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, 7000);
  assert.match(hits[0].evidence, /host1, staged with Postbox 1\.16\.1, installed 1\.17\.0 by itself, then @researcher finished a turn there/);
  assert.equal(trigger.issue, 464);
});

test('#464 host-auto-installed stays silent on a host that wasn’t staged', () => {
  assert.deepEqual(trigger.run(installed({ setup: { staged: undefined } })), []);
  assert.deepEqual(trigger.run({}), [], 'a run without hosts');
});

test('#464 host-auto-installed stays silent when the install was of another version', () => {
  const other = once().map((s) => (s.update ? { ...s, update: { ...s.update, version: '1.16.2' } } : s));
  assert.deepEqual(trigger.run(installed({ statuses: other })), []);
});

test('#464 host-auto-installed stays silent when the try didn’t end installed', () => {
  assert.deepEqual(trigger.run(installed({ statuses: [status(5001, 'started'), status(6000, 'failed')] })), []);
});

test('#464 host-auto-installed stays silent when this run’s version was installed there more than once', () => {
  const twice = [...once(), status(8000, 'started', { tried: 7900 }), status(8500, 'installed', { tried: 7900 })];
  assert.deepEqual(trigger.run(installed({ statuses: twice, second: { at: 9000 } })), []);
});

test('#464 host-auto-installed stays silent when no turn ran on that host after the install', () => {
  assert.deepEqual(trigger.run(installed({ second: { at: 5500 } })), [], 'the turn started before the install ended');
  assert.deepEqual(trigger.run(installed({ second: { status: 'error' } })), [], 'the turn after it didn’t finish');
  assert.deepEqual(trigger.run(installed({ second: { host: 'ho_2' } })), [], 'the turn after it ran on another host');
});

const repeated = (statuses) => runChecks(installed({ statuses }), { only: ['auto-install-repeated'] });

test('#464 auto-install-repeated: two automatic installs of one version on one host is a finding', () => {
  const twice = [...once(), status(8000, 'started', { tried: 7900 })];
  const got = repeated(twice);
  assert.deepEqual(
    got.map((x) => [x.key, x.issue]),
    [['host1:1.17.0', 464]],
  );
  assert.match(got[0].title, /Postbox installed 1\.17\.0 on host1 by itself 2 times/);
});

test('#464 auto-install-repeated stays silent for one try, however often its status came, and for tries of other versions or hosts', () => {
  assert.deepEqual(repeated(once()), [], 'one try’s started and installed, and its status again');
  assert.deepEqual(repeated([...once(), status(8000, 'started', { tried: 7900, version: '1.18.0' })]), [], 'another version');
  assert.deepEqual(repeated([...once(), status(8000, 'started', { tried: 7900, id: 'ho_2' })]), [], 'another host');
  assert.deepEqual(repeated([...once(), status(8000, 'failed', { tried: 7900 })]), [], 'a status with only a failed try shows no install started');
  assert.deepEqual(runChecks(facts(), { only: ['auto-install-repeated'] }), [], 'a run with no statuses kept');
});

const waited = HOST_TRIGGERS['host-turn-waited-install'];
/** As installed(), with host1’s first turn, @researcher’s at 2500, finished rather than failed (#464-b2b). */
const waitedRun = (over = {}) => {
  const f = installed(over);
  f.state.items.t1[0].status = 'done';
  return f;
};

test('#464-b2b host-turn-waited-install fires when a staged host’s first turn started before the install ended, and finished', () => {
  const hits = waited.run(waitedRun());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, 2500);
  assert.match(hits[0].evidence, /host1’s first turn, @researcher’s, waited while Postbox installed 1\.17\.0 there by itself, then finished/);
  assert.equal(waited.issue, 464);
});

test('#464-b2b host-turn-waited-install stays silent when the first turn failed, as in b2a', () => {
  assert.deepEqual(waited.run(installed()), [], 'the first turn failed as not installed');
});

test('#464-b2b host-turn-waited-install stays silent when the first turn there started after the install ended', () => {
  const f = waitedRun();
  f.state.items.t1[0].at = 6500;
  assert.deepEqual(waited.run(f), []);
});

test('#464-b2b host-turn-waited-install stays silent without one install of this run’s version, or a staged host', () => {
  assert.deepEqual(waited.run(waitedRun({ statuses: [status(5001, 'started'), status(6000, 'failed')] })), []);
  assert.deepEqual(waited.run(waitedRun({ setup: { staged: undefined } })), []);
  assert.deepEqual(waited.run({}), [], 'a run without hosts');
});
