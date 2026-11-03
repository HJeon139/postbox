// An older Postbox staged on a test host before a host-mode run (#464; tools/uat/hosts-stage.mjs): the option’s
// checks, setting the host up with the staging in place of Install, the temporary worktree removed however the
// staging ended, the not-installed status the run then records, and the trigger that reads it.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostMode, stagedOf } from '../tools/uat/hosts-options.mjs';
import { createHostRun, setUpHost } from '../tools/uat/hosts-run.mjs';
import { stageOlder, tagRepo } from '../tools/uat/hosts-stage.mjs';
import { hostsUp } from '../tools/uat/hosts-watch.mjs';
import { selectPhases } from '../tools/uat/phases.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { HOST_TRIGGERS } from '../tools/uat/triggers-host.mjs';

const DEST = 'host-a.example.com';
const remotehosts = () => parseScenario(readFileSync(new URL('uat/e2e/scenarios/remotehosts.md', import.meta.url), 'utf8'));
/** A checkout whose tags are these, at these package versions, on 1.17.0. */
const repo = (tags = { 'v1.16.1': '1.16.1', 'v1.17.0': '1.17.0' }) => {
  const asked = [];
  return {
    asked,
    current: () => '1.17.0',
    versionAt: (t) => {
      asked.push(t);
      return tags[t] ?? null;
    },
  };
};
const twoHosts = { host: [DEST, 'host-b.example.com'] };
const trigger = HOST_TRIGGERS['host-staged-older'];

test('#464 --stage-host-version takes a tag here at another version, and stages it on host1 only', () => {
  assert.deepEqual(stagedOf({ ...twoHosts, 'stage-host-version': 'v1.16.1' }, 2, repo()), { tag: 'v1.16.1', version: '1.16.1' });
  assert.equal(stagedOf(twoHosts, 2, repo()), null, 'no option, nothing staged');
  const { hosts } = hostMode({ ...twoHosts, 'stage-host-version': 'v1.16.1' }, 'remotehosts', selectPhases(remotehosts(), [4]), repo());
  assert.deepEqual(hosts[0].stage, { tag: 'v1.16.1', version: '1.16.1' });
  assert.equal(hosts[1].stage, undefined);
});

test('#464 --stage-host-version refuses a tag that isn’t vX.Y.Z before reading the checkout', () => {
  for (const bad of ['1.16.1', 'v1.16', 'v1.16.1-rc1', 'main', 'v1.16.1;rm'])
    assert.throws(() => stagedOf({ ...twoHosts, 'stage-host-version': bad }, 2, repo()), /takes a release tag, such as v1\.16\.1/, bad);
  const r = repo();
  assert.throws(() => stagedOf({ 'stage-host-version': '--upload-pack=x' }, 1, r), /takes a release tag/);
  assert.deepEqual(r.asked, [], 'git is never asked about it');
});

test('#464 --stage-host-version needs a --host to stage on', () => {
  assert.throws(() => stagedOf({ 'stage-host-version': 'v1.16.1' }, 0, repo()), /this run has no --host/);
  assert.throws(() => hostMode({ 'stage-host-version': 'v1.16.1' }, 'remotehosts', remotehosts(), repo()), /this run has no --host/);
});

test('#464 --stage-host-version refuses this checkout’s own version, and a tag that isn’t here', () => {
  assert.throws(() => stagedOf({ ...twoHosts, 'stage-host-version': 'v1.17.0' }, 2, repo()), /Postbox 1\.17\.0, the version this run installs/);
  assert.throws(() => stagedOf({ ...twoHosts, 'stage-host-version': 'v9.9.9' }, 2, repo()), /no such tag in this checkout/);
});

test('#464 a staged run plays only the phase that names host-staged-older, and a run without it never plays that phase', () => {
  const opt = { ...twoHosts, 'stage-host-version': 'v1.16.1' };
  assert.throws(() => hostMode(opt, 'remotehosts', remotehosts(), repo()), /“Phase 1: .*need.*--phases/);
  assert.throws(() => hostMode(twoHosts, 'remotehosts', remotehosts(), repo()), /“Phase 4: An older Postbox on the host” needs an older Postbox/);
  assert.doesNotThrow(() => hostMode(twoHosts, 'remotehosts', selectPhases(remotehosts(), [1, 2, 3]), repo()));
});

test('#464 the checkout’s tags: a tag that isn’t a commit here has no version, and one that is reads its package.json', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { code: args[3] === 'v1.16.1^{commit}' ? 0 : 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '{"name":"postbox","version":"1.16.1"}', stderr: '' };
  };
  const r = tagRepo('/repo', run);
  assert.equal(r.versionAt('v1.16.1'), '1.16.1');
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--quiet', 'v1.16.1^{commit}']);
  assert.equal(r.versionAt('v0.0.1'), null);
  assert.equal(calls.length, 3, 'no git show for a tag that isn’t there');
});

/** A host run on host1 with an older Postbox to stage, its data folder in a temp run folder of its own. */
function stagedRun() {
  const dir = mkdtempSync(join(tmpdir(), 'pb-stage-'));
  const lines = [];
  const hr = createHostRun({
    hosts: [{ label: 'host1', destination: DEST, settings: { idleTimeout: 60_000 }, stage: { tag: 'v1.16.1', version: '1.16.1' } }],
    placement: { researcher: 'host1' },
    launcher: null,
    root: '/repo',
    stamp: '20261103-1200',
    data: join(dir, 'data'),
    log: (l) => lines.push(l),
  });
  return { hr, dir, lines, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('#464 setting up a host with an older Postbox to stage stages it in place of Install, and records only the version', async () => {
  const { hr, lines, done } = stagedRun();
  const staged = [];
  const ui = {
    addHost: async () => 'ho_1',
    makeRunFolder: async () => {},
    editHost: async () => {},
    install: async () => assert.fail('the UI’s Install isn’t used on a staged host'),
    stage: async (o) => {
      staged.push(o);
      return { installed: true };
    },
  };
  await setUpHost(hr, hr.hosts[0], 'pr_1', ui);
  done();
  assert.equal(staged.length, 1);
  assert.deepEqual(staged[0].host, { id: 'ho_1', name: DEST, settings: { idleTimeout: 60_000 } });
  assert.equal(staged[0].version, '1.16.1');
  assert.equal(staged[0].data, hr.record.laptopData, 'the token goes where the run’s Postbox reads it');
  assert.equal(hr.record.setup[0].label, 'host1');
  assert.equal(hr.record.setup[0].staged, '1.16.1');
  assert.doesNotMatch(JSON.stringify(hr.record.setup) + lines.join('\n'), /example\.com|\/repo|pb-stage/, 'no destination or path');
});

/** git as the staging runs it, recording each call; a worktree add makes nothing, as the fake load reads nothing. */
const fakeGit =
  (calls, addCode = 0) =>
  (args) => {
    calls.push(args);
    return { code: args[1] === 'add' ? addCode : 0, stdout: '', stderr: 'fatal: no' };
  };

test('#464 staging installs with the tag’s own install.mjs from a worktree in the run’s folder, which it removes after', async () => {
  const { hr, dir, done } = stagedRun();
  const calls = [];
  const got = [];
  const load = async (file) => ({
    installHost: async (o) => {
      got.push({ file, o });
      return { installed: true, version: o.version };
    },
  });
  const host = { id: 'ho_1', name: DEST, settings: {} };
  await stageOlder({ root: '/repo', tag: 'v1.16.1', version: '1.16.1', data: hr.record.laptopData, label: 'host1', host }, { run: fakeGit(calls), load });
  const tree = calls[0][3];
  assert.deepEqual(calls[0], ['worktree', 'add', '--detach', tree, 'v1.16.1']);
  assert.ok(tree.startsWith(join(dir, 'staged-')), 'in the run’s own folder');
  assert.equal(got[0].file, join(tree, 'server', 'remote', 'install.mjs'));
  assert.deepEqual(got[0].o, { host, version: '1.16.1', dataDir: hr.record.laptopData });
  assert.deepEqual(calls[1], ['worktree', 'remove', '--force', tree]);
  assert.deepEqual(readdirSync(dir), [], 'the temporary folder is gone');
  done();
});

test('#464 staging that fails still removes its worktree, and its error names the host’s label, not its destination', async () => {
  const { hr, dir, done } = stagedRun();
  const calls = [];
  const load = async () => ({
    installHost: async () => {
      throw new Error(`This Postbox’s host program couldn’t be installed on ${DEST}.`);
    },
  });
  const host = { id: 'ho_1', name: DEST, settings: {} };
  const o = { root: '/repo', tag: 'v1.16.1', version: '1.16.1', data: hr.record.laptopData, label: 'host1', host };
  await assert.rejects(
    stageOlder(o, { run: fakeGit(calls), load }),
    (e) => /Staging Postbox 1\.16\.1 on host1 failed: .*installed on host1\./.test(e.message) && !e.message.includes(DEST),
  );
  assert.deepEqual(calls.at(-1), ['worktree', 'remove', '--force', calls[0][3]]);
  assert.equal(existsSync(calls[0][3]), false);
  const failedAdd = [];
  await assert.rejects(stageOlder(o, { run: fakeGit(failedAdd, 128), load }), /git couldn’t check v1\.16\.1 out to stage it on host1/);
  assert.deepEqual(failedAdd.at(-1)[1], 'remove', 'a worktree half made is removed too');
  assert.deepEqual(readdirSync(dir), []);
  done();
});

/** A staged host1 whose setup is recorded, and the status Postbox shows for it. */
function upRun(states = []) {
  const { hr, done } = stagedRun();
  done();
  hr.hosts[0].id = 'ho_1';
  hr.record.setup.push({ label: 'host1', staged: '1.16.1', stagedAt: 1000, launcher: null });
  hr.hostStates = () => states;
  return hr;
}
const notInstalled = { state: 'not-installed', failure: { kind: 'not-installed', message: 'This Postbox’s host program isn’t installed.' } };

test('#464 a staged host that reads not installed is recorded, and doesn’t stop the run as an unstaged one does', () => {
  const hr = upRun();
  assert.doesNotThrow(() => hostsUp(hr, { hostStatus: { ho_1: notInstalled } }));
  assert.ok(Number.isFinite(hr.record.setup[0].notInstalled));
  const plain = upRun();
  delete plain.record.setup[0].staged;
  assert.throws(() => hostsUp(plain, { hostStatus: { ho_1: notInstalled } }), /reads not installed/);
});

test('#464 a staged host’s not installed from before the staging, or with no token and no failure, isn’t the one recorded', () => {
  const hr = upRun([
    { at: 500, id: 'ho_1', state: 'not-installed', failure: 'not-installed' },
    { at: 1500, id: 'ho_1', state: 'not-installed', failure: null },
  ]);
  hostsUp(hr, { hostStatus: { ho_1: { state: 'not-installed', failure: null } } });
  assert.equal(hr.record.setup[0].notInstalled, undefined);
  hr.hostStates = () => [{ at: 2000, id: 'ho_1', state: 'not-installed', failure: 'not-installed' }];
  hostsUp(hr, { hostStatus: { ho_1: { state: 'disconnected', failure: null } } });
  assert.equal(hr.record.setup[0].notInstalled, 2000, 'from the event, when it came');
});

const factsWith = (setup) => ({ hosts: { hosts: [{ label: 'host1', id: 'ho_1', destination: DEST }], placement: { researcher: 'host1' }, setup } });

test('#464 host-staged-older fires when a staged host read not installed before this run’s version connected', () => {
  const hits = trigger.run(factsWith([{ label: 'host1', staged: '1.16.1', notInstalled: 2000 }]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, 2000);
  assert.match(hits[0].evidence, /host1, with Postbox 1\.16\.1 staged on it, read not installed/);
  assert.equal(trigger.run(factsWith([{ label: 'host1', staged: '1.16.1', notInstalled: 2000, connected: { at: 3000 } }])).length, 1, 'connected later');
  assert.equal(trigger.recorded(factsWith([])), true);
});

test('#464 host-staged-older stays silent without a staging, or when this run’s version connected first', () => {
  assert.deepEqual(trigger.run(factsWith([{ label: 'host1', notInstalled: 2000 }])), []);
  assert.deepEqual(trigger.run(factsWith([{ label: 'host1', staged: '1.16.1' }])), []);
  assert.deepEqual(trigger.run(factsWith([{ label: 'host1', staged: '1.16.1', notInstalled: 2000, connected: { at: 1500 } }])), []);
  assert.deepEqual(trigger.run({}), []);
});
