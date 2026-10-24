// A headless Chrome check of how a host-mode UAT run stops on Ctrl-C (#120; tools/uat/stop.mjs): with a host set up
// and installed, a SIGINT to the run’s whole process group, as a terminal sends it, must leave Postbox and Chrome up
// long enough to remove the host through the UI, then remove the run’s own folder there and nothing else of
// ~/postbox-uat, then exit 130 with Postbox and Chrome gone. The run is tests/fixtures/uat/stop-run.mjs, the host a
// folder on this computer, and ssh a stand-in that runs the remote command there with sh: Postbox’s install and
// Remove run for real.
//
//   node tools/check-uat-stop.mjs
//
// PB_PORT and PB_CHROME_PORT move it (4940 and 9540 by default). It reports through tools/harness.mjs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4940, 9540);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Short, for the daemon’s sockets under the host’s home.
const root = mkdtempSync('/tmp/pbs-');
const home = join(root, 'h');
const bin = join(root, 'bin');
for (const d of [home, bin, join(root, 'data'), join(root, 'w'), join(home, 'postbox-uat', 'other')]) mkdirSync(d, { recursive: true });
// Another run’s folder under ~/postbox-uat, which this run must leave alone.
writeFileSync(join(home, 'postbox-uat', 'other', 'keep.txt'), 'theirs');
// ssh’s stand-in: options up to `--`, the destination, then the remote command, run with sh in the host’s home.
writeFileSync(
  join(bin, 'ssh'),
  `#!/bin/sh
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
[ "$1" = host.example.com ] || { echo "ssh stand-in: not host.example.com: $1" >&2; exit 255; }
shift
HOME='${home}' PATH='${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin' exec /bin/sh -c "$*"
`,
  { mode: 0o755 },
);

const free = (port) =>
  new Promise((ok) => {
    const s = createServer().once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });

const out = [];
const child = spawn(
  process.execPath,
  [join(ROOT, 'tests', 'fixtures', 'uat', 'stop-run.mjs'), String(PORT), String(CHROME_PORT), join(root, 'data'), join(root, 'w'), home],
  // A process group of its own, as a terminal runs a job, so the signal below reaches all of it and nothing else.
  { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
child.stdout.on('data', (d) => out.push(...String(d).split('\n').filter(Boolean)));
child.stderr.on('data', (d) => out.push(...String(d).split('\n').filter(Boolean)));
const exited = new Promise((ok) => child.once('exit', (code, signal) => ok({ code, signal })));
try {
  for (let i = 0; i < 600 && !out.includes('ready') && child.exitCode === null; i++) await sleep(200);
  const installed = existsSync(join(home, '.postbox-remote')) && existsSync(join(home, 'postbox-uat', 'stop-check', 'work'));
  if (!check(out.includes('ready') && installed, 'the run set its host up: Postbox installed there, and its own folder made', out.slice(-15).join('\n')))
    throw new Error('The run didn’t get ready.');
  process.kill(-(/** @type {number} */ (child.pid)), 'SIGINT');
  const end = await Promise.race([exited, sleep(120_000).then(() => null)]);
  check(end?.code === 130, 'Ctrl-C ends the run with 130, once it has cleaned up', JSON.stringify(end));
  check(
    out.includes('Removed Postbox from host1.'),
    'the cleanup removed the host through the UI, with Postbox and Chrome still up',
    out.slice(-15).join('\n'),
  );
  check(!existsSync(join(home, '.postbox-remote')), '~/.postbox-remote is gone from the host');
  check(!existsSync(join(home, 'postbox-uat', 'stop-check')), 'the run’s own ~/postbox-uat/<run> is gone from the host');
  check(existsSync(join(home, 'postbox-uat', 'other', 'keep.txt')), 'another run’s folder under ~/postbox-uat is still there');
  check((await free(PORT)) && (await free(CHROME_PORT)), 'the run’s Postbox and Chrome stopped with it');
} finally {
  if (child.exitCode === null && child.signalCode === null) process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
finish();
