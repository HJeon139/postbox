// Postbox’s connection to a host ends when ssh does, even while something ssh started holds its pipes (#120). In the
// live UAT, ssh to a host went through a VPN’s ProxyCommand; killed, ssh exited at once, but the proxy kept
// ssh’s stderr open, so the connection read as open with nothing behind it, and Remove timed out. Real processes: a
// stand-in ssh (tests/fixtures/remote/ssh-with-proxy.mjs) and its proxy.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSshConnection } from '../../server/remote/ssh.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { orAfter } from './host.mjs';
import { VERSION } from './remote-lifecycle-fixtures.mjs';

const STANDIN = join(import.meta.dirname, '..', 'fixtures', 'remote', 'ssh-with-proxy.mjs');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('#120 a killed ssh ends its connection at once, and the ProxyCommand it started goes with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-ssh-exit-'));
  const pids = join(dir, 'pids.json');
  const program = join(dir, 'ssh');
  writeFileSync(program, `#!/bin/sh\nexec '${process.execPath}' '${STANDIN}' "$@"\n`, { mode: 0o755 });
  process.env.PB_SSH_PIDS = pids;
  let p = { ssh: 0, proxy: 0 };
  try {
    const c = createSshConnection({ destination: 'host.example.com', settings: defaultHostSettings(), version: VERSION, token: 'a'.repeat(64), program });
    await c.connect();
    p = JSON.parse(readFileSync(pids, 'utf8'));
    assert.ok(alive(p.proxy), 'the proxy runs');
    const closed = new Promise((ok) => c.once('close', (f) => ok(f)));
    const at = Date.now();
    process.kill(p.ssh, 'SIGKILL');
    const f = await orAfter(closed, 5000, 'still open');
    assert.notEqual(f, 'still open', 'the connection ended within 5 s of ssh’s exit');
    assert.ok(Date.now() - at < 3000, `it ended ${Date.now() - at} ms after ssh was killed`);
    assert.equal(c.state, 'closed');
    for (let i = 0; i < 20 && alive(p.proxy); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(p.proxy), false, 'the proxy ssh started is gone too');
  } finally {
    for (const pid of [p.ssh, p.proxy]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    delete process.env.PB_SSH_PIDS;
    rmSync(dir, { recursive: true, force: true });
  }
});
