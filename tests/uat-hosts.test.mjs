// The UAT runner’s host mode (#120): its options, where agents run, the scenarios it refuses, the scenario as it plays
// it, and the runner’s own ssh (its arguments, its scripts and what it reads back). No real ssh: the ssh runner takes a
// fake spawn, and the parsers read output shaped as a probe of a Linux host recorded it.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hostMode, hostsOf, placementOf, refusal, settingValue } from '../tools/uat/hosts-options.mjs';
import { newListeners, parseLsof, treeOf } from '../tools/uat/hosts-probe.mjs';
import { forHosts } from '../tools/uat/hosts-scenario.mjs';
import { hostListeners, launcherScript, onHost, processesOf, SCRIPTS, sshArgs, turnScript } from '../tools/uat/hosts-ssh.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';

const scenario = (name) => parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
const TURN = '0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b';

test('#120 host mode: --host makes host1, host2… in order, each destination checked as the server checks it', () => {
  const hosts = hostsOf({ host: ['a.example.com', 'user@b.example.com'] });
  assert.deepEqual(
    hosts.map((h) => [h.label, h.destination]),
    [
      ['host1', 'a.example.com'],
      ['host2', 'user@b.example.com'],
    ],
  );
  assert.throws(() => hostsOf({ host: ['-oProxyCommand=x'] }), /--host “-oProxyCommand=x”: A destination can’t start with “-”/);
  assert.throws(() => hostsOf({ host: ['a.example.com', 'a.example.com'] }), /same destination twice/);
  assert.deepEqual(hostsOf({}), []);
  assert.throws(() => hostsOf({ place: ['researcher=host1'] }), /no --host/);
});

test('#120 host mode: --host-setting sets hostN’s settings, in units, checked with shared/remote-settings.mjs', () => {
  const [h1, h2] = hostsOf({
    host: ['a.example.com', 'b.example.com'],
    'host-setting': [
      'host1.claudePath=/home/user/tools/bin/claude',
      'host1.idleTimeout=1min',
      'host2.keepAlive.count=5',
      'host2.keepAlive.interval=10s',
      'host2.denyPrompts=false',
    ],
  });
  assert.deepEqual(h1.settings, { claudePath: '/home/user/tools/bin/claude', idleTimeout: 60_000 });
  assert.deepEqual(h2.settings, { keepAlive: { count: 5, interval: 10_000 }, denyPrompts: false });
  assert.equal(settingValue('90s'), 90_000);
  assert.equal(settingValue('2h'), 7_200_000);
  assert.equal(settingValue('600000'), 600_000);
  assert.deepEqual(settingValue('["klist","-s"]'), ['klist', '-s']);
  assert.equal(settingValue('null'), null);
  const one = { host: ['a.example.com'] };
  assert.throws(() => hostsOf({ ...one, 'host-setting': ['host1.idleTimeout=10s'] }), /idleTimeout must be 1 min to 7 days/);
  assert.throws(() => hostsOf({ ...one, 'host-setting': ['host1.claudePath=~/claude'] }), /claudePath must be an absolute path/);
  assert.throws(() => hostsOf({ ...one, 'host-setting': ['host1.nope=1'] }), /There’s no host setting “nope”/);
  assert.throws(() => hostsOf({ ...one, 'host-setting': ['host2.idleTimeout=1min'] }), /there’s no host2; this run has one --host/);
  assert.throws(() => hostsOf({ ...one, 'host-setting': ['idleTimeout=1min'] }), /takes hostN.key=value/);
  assert.throws(() => hostsOf({ 'host-setting': ['host1.idleTimeout=1min'] }), /needs a --host/);
});

test('#120 host mode: placement is the scenario’s `- place:` line, then --place over it, and every place a host the run has', () => {
  const s = scenario('remotehosts');
  assert.deepEqual(s.place, { researcher: 'host1', critic: 'host2', developer: 'local' });
  assert.deepEqual(placementOf(s, [], 2), { researcher: 'host1', critic: 'host2', developer: 'local' });
  assert.deepEqual(placementOf(s, ['critic=local', '@developer=host1'], 2), { researcher: 'host1', critic: 'local', developer: 'host1' });
  assert.throws(
    () => placementOf(s, [], 1),
    /@critic is placed on host2, and this run has one --host\. Give another --host, or --place critic=host1 or critic=local/,
  );
  assert.deepEqual(placementOf(s, ['critic=host1'], 1).critic, 'host1');
  assert.throws(() => placementOf(s, ['nobody=host1'], 2), /@nobody isn’t one of this scenario’s agents/);
  assert.throws(() => placementOf(s, ['critic=elsewhere'], 2), /--place takes handle=hostN or handle=local/);
  // Agents a scenario doesn’t place run here.
  assert.deepEqual(placementOf({ agents: ['researcher'] }, [], 1), { researcher: 'local' });
});

test('#120 host mode refuses codex, mixedroom and geminiroom, and any scenario with an agent off Claude Code', () => {
  for (const name of ['codex', 'mixedroom', 'geminiroom']) {
    const why = refusal(name, scenario(name));
    assert.match(String(why), /--host runs Claude Code agents only/, name);
  }
  assert.match(String(refusal('mine', { backends: { critic: { backend: 'kiro-cli' } } })), /puts agents on kiro-cli/);
  for (const name of ['remotehosts', 'p0', 'workroom', 'scifact']) assert.equal(refusal(name, scenario(name)), null, name);
  assert.throws(() => hostMode({ host: ['a.example.com'] }, 'codex', scenario('codex')), /Claude Code agents only/);
  // Without --host, nothing changes.
  const p0 = scenario('p0');
  assert.equal(hostMode({}, 'p0', p0).scenario, p0);
});

test('#120 host mode plays a phase whose agent runs on a host with its host triggers and text', () => {
  const p0 = scenario('p0');
  const stop = p0.phases[2];
  assert.equal(stop.host, 'researcher');
  assert.deepEqual(stop.triggers, ['stop-keep-jobs', 'stop-jobs-too', 'send-now-job-running']);
  assert.deepEqual(stop.hostTriggers, ['remote-stop-says-jobs', 'remote-stop-no-process-left']);
  assert.doesNotMatch(stop.text, /On a host/);
  assert.match(stop.hostText, /stops with its turn/);
  assert.equal(p0.launcher, 'tools/uat/claude-launcher.mjs');
  const hosts = [{ label: 'host1', destination: 'host.example.com' }];
  const away = forHosts(p0, placementOf(p0, [], 1), hosts);
  assert.deepEqual(away.phases[2].triggers, stop.hostTriggers);
  assert.equal(away.phases[2].text, stop.hostText);
  assert.equal(away.phases[0], p0.phases[0]);
  assert.match(away.summary, /@researcher on host1 \(host\.example\.com\), @critic on this computer/);
  assert.match(away.summary, /fault \{fault, target\}: kill-ssh/);
  // The phase’s agent kept here plays it as written.
  const here = forHosts(p0, placementOf(p0, ['researcher=local'], 1), hosts);
  assert.deepEqual(here.phases[2].triggers, stop.triggers);
  for (const name of ['p0', 'workroom', 'remotehosts']) assert.deepEqual(unknownTriggers(scenario(name)), [], name);
  assert.deepEqual(unknownTriggers({ phases: [{ triggers: [], hostTriggers: ['no-such'] }] }), ['no-such']);
});

test('#120 host mode: the runner’s ssh is an argument list in BatchMode whose remote command is only `sh -s`', async () => {
  assert.deepEqual(sshArgs('host.example.com'), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-T', '--', 'host.example.com', 'sh', '-s']);
  const calls = [];
  const spawn = (cmd, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} });
    child.stdin = {
      end: (input) => {
        calls.push({ cmd, args, input });
        child.stdout.emit('data', 'absent\n');
        child.emit('close', 0);
      },
    };
    return child;
  };
  const r = await onHost('host.example.com', SCRIPTS.removed, { spawn: /** @type {any} */ (spawn) });
  assert.deepEqual(r, { code: 0, stdout: 'absent\n', stderr: '' });
  assert.equal(calls[0].cmd, 'ssh');
  assert.equal(calls[0].input, `${SCRIPTS.removed}\n`);
});

test('#120 host mode: scripts never match themselves, and take only a checked turn ID or plain paths', () => {
  assert.match(SCRIPTS.processes, /'\[\.\]postbox-remote'/);
  const s = turnScript(TURN);
  assert.match(s, /\.postbox-remote\/turns\/0f8e2c1a-/);
  // pgrep’s pattern names the turn, but not as the turn: “[0]f8e…” doesn’t match its own argument.
  assert.match(s, /pgrep -a -u "\$\(id -u\)" -f '\[0\]f8e2c1a-/);
  assert.throws(() => turnScript('x; rm -rf ~'), /isn’t a turn ID/);
  const l = launcherScript({
    launcher: '#!/usr/bin/env node\nconsole.log(1)\n',
    node: '/home/user/.local/share/mise/installs/node/22.12.0/bin/node',
    claude: '/home/user/tools/bin/claude',
  });
  assert.match(l, /POSTBOX_UAT_REAL_CLAUDE='\/home\/user\/tools\/bin\/claude'/);
  assert.match(l, /exec '\/home\/user\/\.local\/share\/mise\/installs\/node\/22\.12\.0\/bin\/node' "\$HOME\/postbox-uat\/bin\/claude-launcher\.mjs" "\$@"/);
  assert.throws(() => launcherScript({ launcher: '', node: "/a'b", claude: '/c' }), /won’t quote/);
  assert.throws(() => launcherScript({ launcher: 'x\nPOSTBOX_UAT_END\n', node: '/n', claude: '/c' }), /line that ends it/);
});

// Shaped as a probe of a Linux host recorded `ss -ltnp` (iproute2, its header’s “PortProcess” run together, and a
// listener of another user’s with no process), host and user names removed; the processes after it are made up.
const LISTENERS = `State  Recv-Q Send-Q      Local Address:Port  Peer Address:PortProcess
LISTEN 0      128               0.0.0.0:22         0.0.0.0:*
LISTEN 0      511             127.0.0.1:8123       0.0.0.0:*    users:(("python3",pid=4242,fd=3))
LISTEN 0      4096            127.0.0.1:27452      0.0.0.0:*    users:(("collector",pid=1555,fd=4))
--ps--
 4100  4100 /home/user/.local/share/mise/installs/node/22.12.0/bin/node /home/user/.postbox-remote/0.24.0/server/remote/host/runner.mjs ${TURN}
 4200  4100 /home/user/tools/bin/claude -p --output-format stream-json
 4242  4100 python3 -m http.server 8123
 5000  5000 -bash`;

test('#120 host mode: a host’s listeners, and which the run’s own processes hold (a session one of Postbox’s is in)', () => {
  const now = hostListeners(LISTENERS);
  assert.deepEqual(
    now.map((x) => x.addr),
    ['0.0.0.0:22', '127.0.0.1:8123', '127.0.0.1:27452'],
  );
  assert.deepEqual([...(now.run ?? [])].sort(), ['4100', '4200', '4242']);
  const diff = newListeners(['0.0.0.0:22', '127.0.0.1:27452'], now);
  assert.deepEqual(diff, { added: ['127.0.0.1:8123 (pid 4242)'], run: ['127.0.0.1:8123 (pid 4242)'] });
  assert.deepEqual(newListeners(['0.0.0.0:22', '127.0.0.1:8123', '127.0.0.1:27452'], now), { added: [], run: [] });
  // Another process’s new listener is listed, not the run’s.
  assert.deepEqual(newListeners(['0.0.0.0:22', '127.0.0.1:8123'], now), { added: ['127.0.0.1:27452 (pid 1555)'], run: [] });
});

test('#120 host mode: this computer’s listeners from lsof, and the run’s Postbox’s process tree from ps', () => {
  const lsof = 'p100\nf5\nn127.0.0.1:4900\np300\nf9\nn127.0.0.1:9500\nf10\nn[::1]:9500\n';
  assert.deepEqual(parseLsof(lsof), [
    { addr: '127.0.0.1:4900', pids: ['100'] },
    { addr: '127.0.0.1:9500', pids: ['300'] },
    { addr: '[::1]:9500', pids: ['300'] },
  ]);
  const tree = treeOf('  100     1\n  101   100\n  102   101\n  300     1\n', 100);
  assert.deepEqual([...tree].sort(), ['100', '101', '102']);
  assert.deepEqual(processesOf(`4100 node runner.mjs ${TURN}\n4100 node runner.mjs ${TURN}\n\n4200 claude -p\n`), [
    `4100 node runner.mjs ${TURN}`,
    '4200 claude -p',
  ]);
});
