// #464-b3’s UAT trigger, host-reinstalled (tools/uat/triggers-host.mjs): on a host this run installed, after the
// tester removed Postbox’s folder there (fault remove-postbox), Postbox installed it again by itself with a new
// token, once, and a turn then finished there. Built on tests/uat-hosts-facts.mjs’s run.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hostMode } from '../tools/uat/hosts-options.mjs';
import { createHostRun, setUpHost } from '../tools/uat/hosts-run.mjs';
import { SCRIPTS } from '../tools/uat/hosts-ssh.mjs';
import { fault, removePostbox } from '../tools/uat/hosts-watch.mjs';
import { selectPhases } from '../tools/uat/phases.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { SCHEMA } from '../tools/uat/tester.mjs';
import { HOST_TRIGGERS } from '../tools/uat/triggers-host.mjs';
import { facts, remote } from './uat-hosts-facts.mjs';

const remotehosts = () => parseScenario(readFileSync(new URL('uat/e2e/scenarios/remotehosts.md', import.meta.url), 'utf8'));
const twoHosts = { host: ['host-a.example.com', 'host-b.example.com'] };

const trigger = HOST_TRIGGERS['host-reinstalled'];
/** A host status event as the run keeps it (hostStateOf), with its newest install try. */
const status = (at, outcome, { tried = 5000, state = 'disconnected' } = {}) => ({
  at,
  id: 'ho_1',
  state,
  failure: null,
  update: outcome ? { version: '1.20.0', at: tried, outcome } : null,
});

/** host1, the folder removed at 4000, reinstalled at 6000, and @researcher’s turn there at 7000. */
function reinstalled({ statuses, fault = {}, turn = {} } = {}) {
  const f = facts();
  f.hosts.faults = [{ fault: 'remove-postbox', label: 'host1', at: 4000, recovered: true, ...fault }];
  f.hosts.statuses = statuses ?? [status(5001, 'started'), status(6000, 'reinstalled'), status(6500, 'reinstalled', { state: 'connected' })];
  const it = { id: 'i4', kind: 'agent', handle: 'researcher', sessionId: 's1', turnId: 'tu_r2', status: 'done', at: 7000, ...turn };
  f.state.items.t1 = [...f.state.items.t1, it];
  f.events.push({ seq: 9, type: 'session', data: { id: 's1', state: 'gen', remoteTurn: remote(turn.host ?? 'ho_1', 'tu_r2', 'h-2') } });
  return f;
}

test('#464-b3 host-reinstalled fires when Postbox put itself back once after its folder was removed, and a turn ran there', () => {
  const hits = trigger.run(reinstalled());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, 7000);
  assert.match(hits[0].evidence, /host1: its folder removed, Postbox installed 1\.20\.0 there again with a new token, then @researcher finished a turn there/);
  assert.equal(trigger.issue, 464);
});

test('#464-b3 host-reinstalled stays silent without the removal, or before it', () => {
  assert.deepEqual(trigger.run(reinstalled({ fault: { fault: 'kill-daemon' } })), [], 'another fault');
  assert.deepEqual(trigger.run(reinstalled({ fault: { at: 6500 } })), [], 'the try came before the removal');
  assert.deepEqual(trigger.run({}), [], 'a run without hosts');
});

test('#464-b3 host-reinstalled stays silent when the install kept the token, or put it back twice', () => {
  const kept = [status(5001, 'started'), status(6000, 'installed')];
  assert.deepEqual(trigger.run(reinstalled({ statuses: kept })), [], 'installed, not reinstalled');
  const twice = [status(5001, 'started'), status(6000, 'reinstalled'), status(6800, 'reinstalled', { tried: 6700 })];
  assert.deepEqual(trigger.run(reinstalled({ statuses: twice })), [], 'twice');
});

test('#464-b3 host-reinstalled stays silent when no turn finished there after it', () => {
  assert.deepEqual(trigger.run(reinstalled({ turn: { at: 5500 } })), [], 'before the reinstall');
  assert.deepEqual(trigger.run(reinstalled({ turn: { status: 'error' } })), [], 'not finished');
  assert.deepEqual(trigger.run(reinstalled({ turn: { host: 'ho_2' } })), [], 'on another host');
});

test('#464-b3 a run that plays phase 5 turns host1’s consent on; one that doesn’t, doesn’t', () => {
  const five = hostMode({ ...twoHosts, phases: '5' }, 'remotehosts', selectPhases(remotehosts(), [5]));
  assert.equal(five.hosts[0].keepUpdated, true, 'host1');
  assert.equal(five.hosts[1].keepUpdated, undefined, 'not host2');
  const first = hostMode({ ...twoHosts, phases: '1' }, 'remotehosts', selectPhases(remotehosts(), [1]));
  assert.equal(first.hosts[0].keepUpdated, undefined);
});

test('#464-b3 setting a host up with keepUpdated installs it, then turns its consent on through the page', async () => {
  const calls = [];
  const hr = createHostRun({
    hosts: [{ label: 'host1', destination: 'host-a.example.com', settings: {}, keepUpdated: true }],
    placement: {},
    launcher: null,
    root: '/repo',
    stamp: '20261105-0300',
    data: '/tmp/pb-b3-unused',
    log: () => {},
  });
  const ui = {
    addHost: async () => 'ho_1',
    makeRunFolder: async () => {},
    editHost: async () => {},
    install: async () => {
      calls.push('install');
      return { installOffered: true, confirm: 'ok' };
    },
    keepUpdated: async (_kit, id) => {
      calls.push(`consent ${id}`);
      return true;
    },
  };
  await setUpHost(hr, hr.hosts[0], 'pr_1', ui);
  assert.deepEqual(calls, ['install', 'consent ho_1'], 'after the install');
  assert.equal(hr.record.setup[0].consent, true);
  const refused = { ...ui, keepUpdated: async () => false };
  hr.hosts[0].id = null;
  await assert.rejects(setUpHost(hr, hr.hosts[0], 'pr_1', refused), /consent to keep Postbox up to date wasn’t kept/);
});

test('#464-b3 the remove-postbox fault runs the removal script, and refuses a host that had Postbox before the run', async () => {
  const ran = [];
  const run = async (/** @type {string} */ dest, /** @type {string} */ script) => {
    ran.push([dest, script]);
    return { code: 0, stdout: 'removed\n', stderr: '' };
  };
  const h = { label: 'host1', destination: 'host-a.example.com' };
  assert.equal(await removePostbox(h, run), 1);
  assert.deepEqual(ran, [['host-a.example.com', SCRIPTS.removeStaged]]);
  await assert.rejects(removePostbox({ ...h, replaceInstall: true }, run), /refused on host1: Postbox was there before this run/);
  assert.equal(ran.length, 1, 'nothing ran on that host');
  const fails = async () => ({ code: 1, stdout: '', stderr: 'rm: busy' });
  await assert.rejects(removePostbox(h, fails), /Couldn’t remove Postbox’s folder on host1: rm: busy/);
  const silent = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(removePostbox(h, silent), /Couldn’t remove Postbox’s folder on host1/, 'not said removed');
});

test('#464-b3 removePostbox throws when the script says removed but exits non-zero', async () => {
  const h = { label: 'host1', destination: 'host-a.example.com' };
  const saidButFailed = async () => ({ code: 2, stdout: 'removed\n', stderr: '' });
  await assert.rejects(removePostbox(h, saidButFailed), /Couldn’t remove Postbox’s folder on host1: exit 2/);
});

test('#464-b3 the remove-postbox fault runs through fault(), records it, and tells the tester it removed the folder', async () => {
  const ran = [];
  const run = async (/** @type {string} */ dest, /** @type {string} */ script) => {
    ran.push([dest, script]);
    return { code: 0, stdout: 'removed\n', stderr: '' };
  };
  const hr = {
    api: async () => ({ state: { hostStatus: { ho_1: { state: 'failed' } } } }),
    hosts: [{ label: 'host1', destination: 'host-a.example.com', id: 'ho_1' }],
    record: { faults: [] },
    placement: {},
    kit: { ev: async () => [] },
    log: () => {},
  };
  const said = await fault(/** @type {any} */ (hr), { fault: 'remove-postbox', target: 'host1' }, { reload: async () => {} }, () => {}, run);
  assert.deepEqual(ran, [['host-a.example.com', SCRIPTS.removeStaged]]);
  assert.match(said, /^Removed Postbox’s folder on host1\. /);
  assert.equal(hr.record.faults.length, 1);
  assert.equal(hr.record.faults[0].fault, 'remove-postbox');
  assert.equal(hr.record.faults[0].label, 'host1');
});

test('#464-b3 host-reinstalled is checkable on a host run, and the tester can ask for remove-postbox', () => {
  assert.equal(trigger.recorded(reinstalled()), true);
  const faults = JSON.stringify(SCHEMA).match(/"enum":\["kill-ssh"[^\]]*\]/g) ?? [];
  assert.ok(faults.length >= 1 && faults.every((f) => f.includes('"remove-postbox"')), faults.join(' '));
});
