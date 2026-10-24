// The UAT runner’s host mode (#120): its options, where agents run, the scenarios it refuses, the scenario as it plays
// it, and the runner’s own ssh (its arguments, its scripts and what it reads back). No real ssh: the ssh runner takes a
// fake spawn, and the parsers read output shaped as a probe of a Linux host recorded it.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hostMode, hostsOf, placementOf, refusal, settingValue } from '../tools/uat/hosts-options.mjs';
import { localListeners, newListeners, parseLsof, treeOf } from '../tools/uat/hosts-probe.mjs';
import { forHosts } from '../tools/uat/hosts-scenario.mjs';
import {
  cleanUpScript,
  hostListeners,
  launcherScript,
  onHost,
  parseTree,
  processesOf,
  SCRIPTS,
  sshArgs,
  stillRunning,
  turnTrees,
  upToEnd,
  workScript,
} from '../tools/uat/hosts-ssh.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { TREE_AFTER, TREE_BEFORE, TURN } from './uat-hosts-facts.mjs';

const scenario = (name) => parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));

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

test('#120 host mode: scripts never match themselves, and take only a checked run stamp or plain paths', () => {
  assert.match(SCRIPTS.processes, /'\[\.\]postbox-remote'/);
  const l = launcherScript({
    launcher: '#!/usr/bin/env node\nconsole.log(1)\n',
    node: '/home/user/.local/share/mise/installs/node/22.12.0/bin/node',
    claude: '/home/user/tools/bin/claude',
    run: '2026-10-24T05-12-33',
  });
  assert.match(l, /POSTBOX_UAT_REAL_CLAUDE='\/home\/user\/tools\/bin\/claude'/);
  // The launcher goes in the run’s own folder, never in a ~/postbox-uat/bin another run shares.
  assert.match(
    l,
    /exec '\/home\/user\/\.local\/share\/mise\/installs\/node\/22\.12\.0\/bin\/node' "\$HOME\/postbox-uat\/2026-10-24T05-12-33\/bin\/claude-launcher\.mjs" "\$@"/,
  );
  assert.doesNotMatch(l, /postbox-uat\/bin/);
  assert.throws(() => launcherScript({ launcher: '', node: "/a'b", claude: '/c', run: 'r' }), /won’t quote/);
  assert.throws(() => launcherScript({ launcher: 'x\nPOSTBOX_UAT_END\n', node: '/n', claude: '/c', run: 'r' }), /line that ends it/);
  for (const bad of ['x; rm -rf ~', '../up', ''])
    for (const make of [workScript, cleanUpScript, (run) => launcherScript({ launcher: '', node: '/n', claude: '/c', run })])
      assert.throws(() => make(bad), /isn’t a run’s stamp/);
  // Cleanup removes the run’s own folder, and its parent only with rmdir, only when the run made it.
  assert.deepEqual(cleanUpScript('r1').split('\n'), [
    'rm -rf -- "$HOME/postbox-uat/r1"',
    'if [ -e "$HOME/postbox-uat/r1" ]; then echo "~/postbox-uat/r1 is still there." >&2; exit 1; fi',
    'echo removed',
  ]);
  assert.match(cleanUpScript('r1', { parent: true }), /^rmdir "\$HOME\/postbox-uat" 2>\/dev\/null$/m);
});

test('#120 host mode: a measuring script counts only when it got to its end', () => {
  assert.equal(upToEnd({ code: 0, stdout: '4100 node host.mjs serve\n--end--\n' }), '4100 node host.mjs serve');
  assert.equal(upToEnd({ code: 0, stdout: '--end--\n' }), '');
  // pgrep missing: sh says so on stderr and the script exits before its end; ssh failing exits 255.
  assert.equal(upToEnd({ code: 127, stdout: '' }), null);
  assert.equal(upToEnd({ code: 0, stdout: '' }), null);
  assert.equal(upToEnd({ code: 255, stdout: '--end--\n' }), null);
  assert.throws(() => hostListeners('--ps--\n 4100 4100 node runner.mjs'), /ss printed nothing/);
  assert.throws(() => hostListeners('State  Recv-Q Send-Q Local Address:Port'), /ss printed nothing/);
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

test('#120 host mode: this computer’s listeners fail closed when lsof or ps can’t say', () => {
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  const run = (lsof, ps = ok('  100     1\n')) => /** @type {any} */ ((cmd) => (cmd === 'lsof' ? lsof : ps));
  assert.deepEqual([...localListeners(100, { run: run(ok('p100\nn127.0.0.1:4900\n')) })], [{ addr: '127.0.0.1:4900', pids: ['100'] }]);
  // lsof exits 1 when it finds nothing to list.
  assert.deepEqual([...localListeners(100, { run: run({ status: 1, stdout: '', stderr: '' }) })], []);
  const missing = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' }) };
  assert.throws(() => localListeners(100, { run: run(missing) }), /Couldn’t read this computer’s listeners with lsof: spawnSync lsof ENOENT/);
  assert.throws(() => localListeners(100, { run: run({ status: 1, stdout: '', stderr: 'lsof: unacceptable port' }) }), /unacceptable port/);
  assert.throws(() => localListeners(100, { run: run(ok(''), { status: 1, stdout: '', stderr: 'ps: bad option' }) }), /with ps: ps: bad option/);
});

test('#120 host mode: a Stop on a host is judged by every process seen under its turn, not its session or ID', () => {
  const trees = turnTrees(parseTree(TREE_BEFORE));
  assert.deepEqual(
    trees.get(TURN)?.map((p) => p.pid),
    ['4100', '4200', '4300', '4301'],
  );
  assert.equal(trees.get(TURN)?.[2].start, 'Sat Oct 24 05:12:40 2026');
  const left = stillRunning(/** @type {any} */ (trees.get(TURN)), parseTree(TREE_AFTER)).map((p) => p.pid);
  // The shell by its PID and start time, the new sleep and the nohup’d command by its group or session; not the
  // daemon, not the PID that was reused, not the user’s own shell.
  assert.deepEqual(left, ['4300', '4302', '4310']);
  assert.deepEqual(stillRunning(/** @type {any} */ (trees.get(TURN)), parseTree(`--ps--\n${TREE_AFTER.split('\n')[1]}`)), []);
  // A runner.json whose PID is now another process’s isn’t a turn’s runner.
  assert.equal(turnTrees(parseTree(`turn ${TURN} 5000\n${TREE_BEFORE.split('\n').slice(1).join('\n')}`)).size, 0);
  assert.throws(() => parseTree(`turn ${TURN} 4100\n`), /didn’t come back/);
  assert.throws(() => parseTree('--ps--\n'), /listed no processes/);
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
