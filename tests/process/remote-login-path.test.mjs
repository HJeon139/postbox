// login-path.mjs’s probe with real shells (#672, #474): small scripts in a temp folder stand in for the login shell,
// as `shell -lic <script>` runs them. One prints a banner and another probe’s markers before running the script; one
// sleeps past the time limit with a child of its own, which the kill of its process group must take too.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathMarkers, probeLoginPath } from '../../server/remote/host/login-path.mjs';
import { tempDir } from '../temp-dirs.mjs';

const UNIX = process.platform === 'linux' || process.platform === 'darwin';
const skip = !UNIX && 'needs a POSIX sh and process groups';
const dir = tempDir('pblps-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** pids a test started, killed after the file if a failing test left one. @type {number[]} */
const started = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

after(() => {
  for (const pid of started.filter(alive)) process.kill(pid, 'SIGKILL');
});

/** A fake login shell: a sh script with `body`, which gets the probe’s `-lic <script>` as $1 and $2. */
function shell(name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('#672: a real shell’s banner and another probe’s markers are ignored; only this probe’s PATH is read', { skip, timeout: 10_000 }, async () => {
  const old = pathMarkers('99999999-8888-4777-8666-555555555555');
  const sh = shell(
    'banner',
    `echo 'Welcome to the host'\nprintf '%s/evil/bin%s\\n' '${old.start}' '${old.end}'\nPATH=/login/bin:/usr/bin:/bin:/login/bin\neval "$2"`,
  );
  const r = await probeLoginPath({ shell: sh });
  assert.ok(r.ok, r.ok ? '' : r.why);
  assert.deepEqual(r.entries, ['/login/bin', '/usr/bin', '/bin']);
  assert.ok(r.ms >= 0);
});

test('#672: a shell past the time limit fails, and its whole process group is killed', { skip, timeout: 10_000 }, async () => {
  const pidFile = join(dir, 'child.pid');
  const sh = shell('slow', `sleep 30 &\necho $! > '${pidFile}'\nwait`);
  const t0 = Date.now();
  const r = await probeLoginPath({ shell: sh, timeoutMs: 300 });
  const took = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.why.length > 0);
  assert.ok(took < 300 + 1500, `took ${took} ms`);
  assert.ok(existsSync(pidFile), 'the shell started its child');
  const child = Number(readFileSync(pidFile, 'utf8'));
  started.push(child);
  const end = Date.now() + 3000;
  while (alive(child) && Date.now() < end) await sleep(20);
  assert.equal(alive(child), false, `the shell’s child ${child} outlived the probe`);
});

test('#672: a real shell that prints no markers, or exits non-zero, fails with a reason', { skip, timeout: 10_000 }, async () => {
  const none = await probeLoginPath({ shell: shell('none', 'echo /login/bin:/usr/bin') });
  assert.equal(none.ok, false);
  const failed = await probeLoginPath({ shell: shell('fails', 'eval "$2"\nexit 3') });
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.why.includes('3'), !failed.ok ? failed.why : '');
});
