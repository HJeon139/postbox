// #510: Postbox had no unhandledRejection handler, and Node’s default is to exit, so one async timer callback that threw
// stopped the server and every conversation in it. A real server here gets a timer callback that rejects (preloaded from
// tests/process/reject-on-signal.mjs, with its own port and --data folder), and still answers afterward, with the error
// and its stack in its log.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A port nothing on 127.0.0.1 listens on, from the OS. */
const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer()
      .once('error', fail)
      .listen(0, '127.0.0.1', () => {
        const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
        s.close(() => ok(port));
      });
  });

/** Resolves once the server’s output includes text; fails if it exits first, or after 10 s. */
const said = (server, log, text) =>
  new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`The server didn’t say “${text}” in 10 s:\n${log.out}`)), 10_000);
    const look = () => {
      if (!log.out.includes(text)) return;
      clearTimeout(timer);
      ok();
    };
    server.stdout.on('data', look);
    server.stderr.on('data', look);
    server.once('exit', (code) => fail(new Error(`The server exited with ${code}:\n${log.out}`)));
    look();
  });

test('#510 an async timer callback that rejects is logged with its stack, and the server keeps answering', { skip: process.platform === 'win32' }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'pb-510-'));
  const port = await freePort();
  const server = spawn(
    process.execPath,
    ['--import', join(ROOT, 'tests/process/reject-on-signal.mjs'), join(ROOT, 'server/index.mjs'), '--port', String(port), '--data', data],
    { cwd: ROOT, env: { ...process.env, POSTBOX_HOME: data }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = { out: '' };
  server.stdout.on('data', (d) => (log.out += d));
  server.stderr.on('data', (d) => (log.out += d));
  const exited = new Promise((ok) => server.once('exit', (code, signal) => ok({ code, signal })));
  try {
    await said(server, log, 'Postbox is running');
    server.kill('SIGUSR2');
    await said(server, log, 'the #510 test’s rejection');
    // Its stack too, so the person can tell which callback it was.
    assert.match(log.out, /reject-on-signal\.mjs:\d+/);
    const r = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(r.status, 200, 'the server still answers');
  } finally {
    server.kill('SIGTERM');
    await exited;
    await rm(data, { recursive: true, force: true });
  }
});
