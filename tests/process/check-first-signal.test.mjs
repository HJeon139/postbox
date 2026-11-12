// The first signal npm run check is sent stops the running stage’s whole process group, not only npm (#815;
// tools/check.mjs). npm passes on only SIGINT and SIGTERM, and only to its shell: a SIGHUP left the stage running in
// the run folder check had removed, and a Ctrl-C let `a && b` run b once a ended. Each test runs check, npm, a shell
// and node as real processes, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { STAGES } from '../../tools/check.mjs';
import { PREFIX } from '../../tools/gate-tmp.mjs';
import { tempDir } from '../temp-dirs.mjs';

const CHECK = fileURLToPath(new URL('../../tools/check.mjs', import.meta.url));
const skip = process.platform === 'win32' && 'needs process groups';

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

/**
 * A project in a temp folder whose `stage` script is `script`, every stage before it passing at once, with the
 * files in `files`, and its log, where the stage’s processes append what they do. Starts check in it, and returns
 * its exit code (or 'still running' after 20 s), its output, and the stage’s pid once its first line is logged.
 * @param {import('node:test').TestContext} t @param {string} stage @param {string} script
 * @param {Record<string, string>} files
 */
function startCheck(t, stage, script, files) {
  const root = tempDir('pb-sig1-');
  const [tmp, log] = [join(root, 'tmp'), join(root, 'log')];
  mkdirSync(tmp);
  writeFileSync(join(root, 'npmrc'), '');
  writeFileSync(log, '');
  const scripts = Object.fromEntries(STAGES.slice(0, STAGES.indexOf(stage)).map((s) => [s, 'exit 0']));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pb-sig1', private: true, scripts: { ...scripts, [stage]: script } }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text.replaceAll('LOG', JSON.stringify(log)));
  const env = { ...process.env, TMPDIR: tmp, POSTBOX_HEAVY_DIR: join(root, 'heavy'), npm_config_userconfig: join(root, 'npmrc') };
  delete env.NODE_TEST_CONTEXT;
  const gate = spawn(process.execPath, [CHECK], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  for (const s of [gate.stdout, gate.stderr]) s.on('data', (d) => (out += d));
  /** @type {Promise<number | string | null>} */
  const exited = new Promise((ok) => {
    const timer = setTimeout(() => ok('still running'), 20_000);
    gate.on('exit', (code, signal) => {
      clearTimeout(timer);
      ok(code ?? signal);
    });
  });
  const logged = () => readFileSync(log, 'utf8');
  const startedPid = () => Number(/^started (\d+)/.exec(logged())?.[1]);
  const started = (async () => {
    for (const end = Date.now() + 15_000; Date.now() < end; await sleep(50)) if (startedPid()) return startedPid();
    // One more look at the deadline, so a stall past it doesn’t miss a start that happened meanwhile.
    if (startedPid()) return startedPid();
    throw new Error(`The stage didn’t start within 15 s:\n${out}`);
  })();
  // Whatever fails, nothing this test started outlives it.
  t.after(() => {
    gate.kill('SIGKILL');
    const pid = Number(/^started (\d+)/.exec(logged())?.[1]);
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
  const runFolders = () => readdirSync(tmp).filter((name) => name.startsWith(PREFIX));
  return { gate, exited, started, logged, runFolders, output: () => out };
}

test('#815 a SIGHUP stops the running stage, which writes nothing more into the run’s removed folder', { skip, timeout: 60_000 }, async (t) => {
  const stage = [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "appendFileSync(LOG, 'started ' + process.pid + '\\n');",
    'setTimeout(() => {',
    "  appendFileSync(LOG, 'still running\\n');",
    "  try { writeFileSync(join(process.env.TMPDIR, 'late'), ''); } catch (e) { appendFileSync(LOG, e.code + ' in the run folder\\n'); }",
    '}, 2000);',
  ].join('\n');
  const c = startCheck(t, 'test', 'node stage.mjs', { 'stage.mjs': stage });
  const pid = await c.started;
  c.gate.kill('SIGHUP');
  assert.equal(await c.exited, 129, `check exits 129 after a SIGHUP:\n${c.output()}`);
  await goneWithin(pid, 4_000);
  assert.equal(c.logged(), `started ${pid}\n`, 'the stage logs nothing after the SIGHUP');
  assert.deepEqual(c.runFolders(), [], 'the run’s folder is removed');
});

test('#815 the first Ctrl-C stops a chained stage, `a && b`, before b runs', { skip, timeout: 60_000 }, async (t) => {
  const a = "import { appendFileSync } from 'node:fs';\nappendFileSync(LOG, 'started ' + process.pid + '\\n');\nsetTimeout(() => {}, 2000);\n";
  const b = "import { appendFileSync } from 'node:fs';\nappendFileSync(LOG, 'b ran\\n');\n";
  const c = startCheck(t, 'lint', 'node a.mjs && node b.mjs', { 'a.mjs': a, 'b.mjs': b });
  const pid = await c.started;
  c.gate.kill('SIGINT');
  assert.equal(await c.exited, 130, `check exits 130 after a Ctrl-C:\n${c.output()}`);
  assert.equal(await goneWithin(pid, 4_000), true, 'a is gone');
  assert.equal(c.logged(), `started ${pid}\n`, 'b never runs');
  assert.deepEqual(c.runFolders(), [], 'the run’s folder is removed');
});
