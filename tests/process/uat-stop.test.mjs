// How a host-mode UAT run stops on Ctrl-C (#120; tools/uat/stop.mjs): with a host set up and installed, a SIGINT to
// the run’s whole process group, as a terminal sends it, must leave Postbox and Chrome up long enough to remove the
// host through the UI, then remove the run’s own folder there and nothing else of ~/postbox-uat, then exit 130 with
// Postbox and Chrome gone. The run is tests/fixtures/uat/stop-run.mjs, the host a folder on this computer, and ssh a
// stand-in that runs the remote command there with sh: Postbox’s install and Remove run for real. It starts the run,
// its Postbox and its Chrome as processes, so it’s under tests/process/ (npm run test:process). Moved from
// tools/check-uat-stop.mjs.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { free, freePort, useChrome } from './chrome.mjs';

const skip = await useChrome();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// How long the run may take to set its host up, and then to clean up and exit, on a busy computer.
const READY_MS = 120_000;
const EXIT_MS = 120_000;

let root = '';
let home = '';
let port = 0;
let chromePort = 0;
/** What the run printed, line by line. @type {string[]} */
const out = [];
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
/** @type {Promise<{ code: number | null, signal: string | null }>} */
let exited;
let ready = false;
/** How the run ended after Ctrl-C, or null when it didn’t within EXIT_MS. */
let end = /** @type {{ code: number | null, signal: string | null } | null} */ (null);
const tail = () => out.slice(-15).join('\n');

/** The host’s home, the run’s folders, another run’s folder to leave alone, and ssh’s stand-in first on PATH. */
function makeHost() {
  // Short, for the daemon’s sockets under the host’s home.
  root = mkdtempSync('/tmp/pbs-');
  home = join(root, 'h');
  const bin = join(root, 'bin');
  const hostBin = join(root, 'hbin');
  for (const d of [home, bin, hostBin, join(root, 'data'), join(root, 'w'), join(home, 'postbox-uat', 'other')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, 'postbox-uat', 'other', 'keep.txt'), 'theirs');
  // ssh’s stand-in: options up to `--`, the destination, then the remote command, run with sh in the host’s home.
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
[ "$1" = host.example.com ] || { echo "ssh stand-in: not host.example.com: $1" >&2; exit 255; }
shift
HOME='${home}' PATH='${hostBin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin' exec /bin/sh -c "$*"
`,
    { mode: 0o755 },
  );
  // pgrep on the host, which is this computer: only what runs from this host’s home. The run checks that nothing of
  // Postbox is left running there, and another run of this test at once, or a daemon one left, isn’t on this host.
  writeFileSync(
    join(hostBin, 'pgrep'),
    `#!/bin/sh
out=$(/usr/bin/pgrep "$@"); s=$?
[ "$s" -gt 1 ] && exit "$s"
mine=$(printf '%s\n' "$out" | while IFS= read -r line; do
  [ -n "$line" ] && ps -o command= -p "\${line%% *}" | grep -qF '${mark()}' && printf '%s\n' "$line"
done)
[ -n "$mine" ] || exit 1
printf '%s\n' "$mine"
`,
    { mode: 0o755 },
  );
  return bin;
}
/** What every command line of this host’s Postbox has in it: its home, whether the system shows /tmp as /private/tmp or not. */
const mark = () => `${basename(root)}/h/.postbox-remote`;

/** Resolves true once the run prints “ready”, false if it exits first or takes longer than ms. */
const untilReady = (ms) =>
  new Promise((ok) => {
    const timer = setTimeout(ok, ms, false);
    const done = (v) => {
      clearTimeout(timer);
      ok(v);
    };
    const read = (d) => {
      out.push(...String(d).split('\n').filter(Boolean));
      if (out.includes('ready')) done(true);
    };
    child?.stdout?.on('data', read);
    child?.stderr?.on('data', read);
    child?.once('exit', () => done(false));
  });

/** p, or null after ms; its timer is cleared either way. */
function within(p, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  return Promise.race([p, new Promise((ok) => (timer = setTimeout(ok, ms, null)))]).finally(() => clearTimeout(timer));
}

before(
  async () => {
    if (skip) return;
    const bin = makeHost();
    port = await freePort();
    chromePort = await freePort([port]);
    child = spawn(
      process.execPath,
      [join(ROOT, 'tests', 'fixtures', 'uat', 'stop-run.mjs'), String(port), String(chromePort), join(root, 'data'), join(root, 'w'), home],
      {
        cwd: ROOT,
        // CHROME comes from useChrome(). A process group of its own, as a terminal runs a job, so the signal below
        // reaches all of it and nothing else.
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    const c = child;
    // Once its output is all read, too.
    exited = new Promise((ok) => c.once('close', (code, signal) => ok({ code, signal })));
    ready = await untilReady(READY_MS);
  },
  { timeout: READY_MS + 10_000 },
);
after(() => {
  if (child && child.exitCode === null && child.signalCode === null) process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
  // The host’s daemon runs in a session of its own, so a run that didn’t clean up leaves it, on this computer.
  if (root) spawnSync('pkill', ['-f', mark().replace('.', '[.]')], { timeout: 10_000 });
  if (root) rmSync(root, { recursive: true, force: true });
});

test('the run set its host up: Postbox installed there, and its own folder made', { skip }, () => {
  assert.ok(ready, `the run printed “ready”:\n${tail()}`);
  assert.ok(existsSync(join(home, '.postbox-remote')), 'Postbox is installed on the host');
  assert.ok(existsSync(join(home, 'postbox-uat', 'stop-check', 'work')), 'the run’s own folder is made there');
});

test('Ctrl-C ends the run with 130, once it has cleaned up', { skip, timeout: EXIT_MS + 10_000 }, async (t) => {
  if (!ready) return t.skip('the run didn’t get ready');
  process.kill(-(/** @type {number} */ (child?.pid)), 'SIGINT');
  end = await within(exited, EXIT_MS);
  assert.deepEqual(end, { code: 130, signal: null }, tail());
});

/** A check of what the cleanup left, once the run has ended. */
const afterwards = (name, fn) =>
  test(name, { skip }, async (t) => {
    if (!end) return t.skip('the run didn’t end after Ctrl-C');
    await fn();
  });

afterwards('the cleanup removed the host through the UI, with Postbox and Chrome still up', () => {
  assert.ok(out.includes('Removed Postbox from host1.'), tail());
});
afterwards('~/.postbox-remote is gone from the host', () => {
  assert.equal(existsSync(join(home, '.postbox-remote')), false);
});
afterwards('the run’s own ~/postbox-uat/<run> is gone from the host', () => {
  assert.equal(existsSync(join(home, 'postbox-uat', 'stop-check')), false);
});
afterwards('another run’s folder under ~/postbox-uat is still there', () => {
  assert.ok(existsSync(join(home, 'postbox-uat', 'other', 'keep.txt')));
});
afterwards('the run’s Postbox and Chrome stopped with it', async () => {
  assert.deepEqual([await free(port), await free(chromePort)], [true, true], 'Postbox’s port and Chrome’s are free');
});
