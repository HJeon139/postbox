// A Postbox that fails to start (#782; tools/uat/postbox.mjs, startPostbox): once it stops waiting for the server
// to answer, it stops that server before it rejects, so a caller that catches the error and goes on, as a bench
// measuring its next size does, leaves nothing running on the port. The server is a stand-in that writes its pid
// and never listens, so it starts a real process and is under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { portFree, startPostbox } from '../../tools/uat/postbox.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** A free port above 47000, away from the ports the other process tests pick. */
async function freeHighPort() {
  for (let i = 0; i < 100; i++) {
    const port = 47001 + Math.floor(Math.random() * 13000);
    if (await portFree(port)) return port;
  }
  throw new Error('No free port between 47001 and 60000 after 100 tries.');
}

/** The pid the stand-in wrote, once it has, within ms. @param {string} file @param {number} ms */
async function pidIn(file, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (existsSync(file)) return Number(readFileSync(file, 'utf8'));
  }
  throw new Error(`The stand-in server wrote no pid to ${file} within ${ms} ms.`);
}

test('#782 a Postbox that never answers is stopped before startPostbox rejects, and its port is free', { timeout: 60_000 }, async (t) => {
  const root = tempDir('pb-start-');
  const pidFile = join(root, 'pid');
  // A stand-in left running would hold this test’s process open and outlive it.
  t.after(() => {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {}
    }
  });
  mkdirSync(join(root, 'server'));
  writeFileSync(
    join(root, 'server', 'index.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  );
  const port = await freeHighPort();
  const lines = [];
  await assert.rejects(startPostbox({ root, port, data: join(root, 'data'), env: {}, log: (l) => lines.push(l), tries: 4 }), /Postbox didn’t start/);
  const pid = await pidIn(pidFile, 5_000);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `the server it started is still running:\n${lines.join('\n')}`);
  assert.equal(await portFree(port), true, 'its port is free');
});
