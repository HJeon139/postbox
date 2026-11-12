// A second Ctrl-C ends npm run check even when its stage ignores the first (#815; tools/check.mjs). The stage here is
// a real npm script whose process takes a heavy-lock slot and ignores SIGINT: the first Ctrl-C reaches it and changes
// nothing, the second kills the stage’s whole process group, and check exits 130 with its run folder removed and the
// slot free. It runs check, npm and node as real processes, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PREFIX } from '../../tools/gate-tmp.mjs';
import { acquire } from '../../tools/heavy-lock.mjs';
import { tempDir } from '../temp-dirs.mjs';

const CHECK = fileURLToPath(new URL('../../tools/check.mjs', import.meta.url));
const HEAVY_LOCK = new URL('../../tools/heavy-lock.mjs', import.meta.url).href;

/** Whether pid has exited within ms, looking once more at the deadline; a killed process can stay a zombie for a
 * moment before it’s reaped. */
async function goneWithin(/** @type {number} */ pid, /** @type {number} */ ms) {
  const gone = () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (gone()) return true;
  return gone();
}

/** The text in file once it’s been written, within ms, looking once more at the deadline. @param {string} file @param {number} ms */
async function readWithin(file, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  if (existsSync(file)) return readFileSync(file, 'utf8');
  throw new Error(`Nothing was written to ${file} within ${ms} ms.`);
}

/** The child’s exit code, or 'still running' if it hasn’t exited within ms. @param {import('node:child_process').ChildProcess} child */
function exitWithin(child, /** @type {number} */ ms) {
  return new Promise((ok) => {
    const timer = setTimeout(() => ok('still running'), ms);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      ok(code ?? signal);
    });
  });
}

test('#815 a second Ctrl-C kills a stage that ignores the first, frees its heavy-lock slot, and removes the run’s folder', {
  skip: process.platform === 'win32' && 'needs process groups',
  timeout: 60_000,
}, async (t) => {
  const root = tempDir('pb-sig2-');
  const [heavy, tmp, pidFile] = [join(root, 'heavy'), join(root, 'tmp'), join(root, 'pid')];
  mkdirSync(tmp);
  writeFileSync(join(root, 'npmrc'), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pb-sig2', private: true, scripts: { lint: 'node hold.mjs' } }));
  writeFileSync(
    join(root, 'hold.mjs'),
    `import { writeFileSync } from 'node:fs';\nimport { acquire } from ${JSON.stringify(HEAVY_LOCK)};\n` +
      `process.on('SIGINT', () => {});\nawait acquire({ label: 'hold', log: () => {} });\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  );
  const env = { ...process.env, TMPDIR: tmp, POSTBOX_HEAVY_DIR: heavy, POSTBOX_HEAVY_SLOTS: '1', npm_config_userconfig: join(root, 'npmrc') };
  delete env.NODE_TEST_CONTEXT;
  const gate = spawn(process.execPath, [CHECK], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  for (const s of [gate.stdout, gate.stderr]) s.on('data', (d) => (out += d));
  const exited = exitWithin(gate, 20_000);
  // Whatever fails, nothing this test started outlives it.
  t.after(() => {
    gate.kill('SIGKILL');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {}
    }
  });

  const pid = Number(await readWithin(pidFile, 15_000));
  gate.kill('SIGINT');
  assert.equal(await goneWithin(pid, 500), false, 'the stage ignores the first Ctrl-C');
  gate.kill('SIGINT');
  assert.equal(await exited, 130, `check exits 130 after the second Ctrl-C:\n${out}`);
  assert.equal(await goneWithin(pid, 5_000), true, 'the stage’s process is gone');
  const release = await acquire({
    label: 'after',
    dir: heavy,
    slots: 1,
    log: () => {},
    sleep: () => Promise.reject(new Error('the stage’s heavy-lock slot is still held')),
  });
  release();
  assert.deepEqual(
    readdirSync(tmp).filter((name) => name.startsWith(PREFIX)),
    [],
    'the run’s folder is removed',
  );
});
