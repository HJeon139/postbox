// Postbox’s close stops agy’s /usage, asked as it started (#1494): a stand-in agy that never answers is stopped, the
// close isn’t held up by it, and nothing is recorded or dropped after the store closes. Runs here because
// tests/guard.mjs bans spawning in the unit suite.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { start } from '../../server/index.mjs';

const none = async () => null;

/** Whether a process is still running. @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A stand-in agy, which Postbox runs through POSTBOX_AGY_BIN for this test: it writes its pid, then never answers.
 * @param {import('node:test').TestContext} t @param {string} dir @returns {Promise<string>} the file it writes its pid to
 */
async function standInAgy(t, dir) {
  const bin = join(dir, 'agy');
  const pidFile = join(dir, 'agy.pid');
  await writeFile(
    bin,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30_000);\n`,
  );
  await chmod(bin, 0o755);
  const was = process.env.POSTBOX_AGY_BIN;
  process.env.POSTBOX_AGY_BIN = bin;
  t.after(() => {
    if (was === undefined) delete process.env.POSTBOX_AGY_BIN;
    else process.env.POSTBOX_AGY_BIN = was;
  });
  return pidFile;
}

/** The pid the stand-in wrote, once it has, within 5 s; 0 if it never did. @param {string} pidFile */
async function pidIn(pidFile) {
  for (let i = 0; i < 100; i++) {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || 0;
    if (pid) return pid;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return 0;
}

test('close stops a pending /usage probe: agy is gone, close is quick, and nothing is recorded after', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-agy-quota-close-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = await standInAgy(t, dir);
  const dataDir = join(dir, 'data');
  const opts = {
    dataDir,
    listen: false,
    quiet: true,
    hosts: null,
    claudeHome: dir,
    probes: { claude: none, sdk: none, kiro: none, codex: none, agy: async () => '1.5.10' },
  };
  // A room with an Antigravity agent, so the next start asks.
  const first = await start(opts);
  first.rt.createPersona({ handle: 'gemini', backend: 'antigravity-cli' });
  await first.close();
  await rm(pidFile, { force: true });

  /** @type {string[]} */
  const errors = [];
  const error = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  t.after(() => {
    console.error = error;
  });
  const app = await start(opts);
  const pid = await pidIn(pidFile);
  assert.ok(pid, 'Postbox asked agy as it started');
  const t0 = Date.now();
  await app.close();
  assert.ok(Date.now() - t0 < 5000, `close took ${Date.now() - t0} ms`);
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(alive(pid), false, 'the stand-in agy was stopped');
  assert.equal(app.rt.s.quota?.['antigravity-cli'], undefined, 'nothing recorded');
  assert.deepEqual(
    errors.filter((e) => /after the store closed|Antigravity/.test(e)),
    [],
  );
});
