// Postbox as an installed npm package (#157, #90):
// - `npm pack` ships what runs (bin/, app/, server/, shared/ and the docs), with the commit it was packed from, and
//   nothing of data/, uat-runs/, the tests, the tools, the designs, the mockups or the screenshots;
// - the tarball installs into a temp prefix, and `postbox --help` and `--version` answer;
// - `postbox --port <port>`, with HOME pointed at a temp folder, serves `/` and the build line (version and commit), and
//   writes only under HOME/.postbox: not in the package, not in the folder it was started from, nowhere else in HOME.
// It runs npm and the installed postbox, which tests/guard.mjs keeps out of the unit tests, so it’s under
// tests/process/ (npm run test:process). Everything happens in a temp folder. The install is a project install into
// the prefix, offline and without the optional packages (the Agent SDK and Kokoro, about 750 MB): npm ignores
// --omit=optional for a global install. Its `postbox` is still npm’s link to bin/postbox.mjs, as a global install’s
// is. Moved from tools/check-install.mjs (#303).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// Node’s own folder first, so `npm` and the bin’s `#!/usr/bin/env node` find this Node and not a version manager’s shim,
// which may not start under a temp HOME.
const PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`;

/** Every file and folder under dir, with its size and modification time, keyed by its path relative to dir. */
async function snapshot(dir, base = dir, out = new Map()) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    out.set(relative(base, full), `${s.size}:${s.mtimeMs}`);
    if (e.isDirectory() && !e.isSymbolicLink()) await snapshot(full, base, out);
  }
  return out;
}
/** What changed between two snapshots: paths added, removed or rewritten. */
const changed = (was, now) => [...new Set([...was.keys(), ...now.keys()])].filter((k) => was.get(k) !== now.get(k)).sort();
/**
 * A free port, picked at random below the ephemeral ranges, as tests/browser/postbox.mjs picks them: the system hands
 * those out in order, so one picked there could be given away before postbox binds it.
 */
async function freePort() {
  const free = (port) =>
    new Promise((ok) => {
      const s = createServer()
        .once('error', () => ok(false))
        .listen(port, '127.0.0.1', () => s.close(() => ok(true)));
    });
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (await free(port)) return port;
  }
  throw new Error('No free port between 20000 and 32000 after 100 tries.');
}
/** What a started postbox printed, once it says it’s running; it fails if it exits first, or takes 10 s. */
const running = (server) =>
  new Promise((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`postbox didn’t say it was running in 10 s:\n${out}`)), 10_000);
    const read = (d) => {
      out += d;
      if (!out.includes('Postbox is running')) return;
      clearTimeout(timer);
      ok(out);
    };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
    server.once('exit', (code) => fail(new Error(`postbox exited with ${code}:\n${out}`)));
  });
/** The commit HEAD is at, as the build line shows it, or null outside a clone. */
function headCommit() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

let tmp = '';
let home = '';
let prefix = '';
let cwd = '';
let packed = { filename: '', files: [{ path: '' }] };
let bin = '';
// The store’s Redis comes from POSTBOX_REDIS_HOME, as in every suite, until the pinned builds have checksums
// (tests/AGENTS.md, “The store’s Redis”); its data still goes under HOME/.postbox.
const runEnv = () => ({
  PATH,
  HOME: home,
  POSTBOX_BACKENDS: 'mock',
  ...(process.env.POSTBOX_REDIS_HOME ? { POSTBOX_REDIS_HOME: process.env.POSTBOX_REDIS_HOME } : {}),
});
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pb-test-install-'));
  [home, prefix, cwd] = ['home', 'prefix', 'cwd'].map((d) => join(tmp, d));
  for (const d of [home, prefix, cwd]) await mkdir(d);
  // npm’s config is an empty file of the test’s own, so nothing of the person’s npm config is read.
  await writeFile(join(tmp, 'npmrc'), '');
  const env = {
    ...process.env,
    PATH,
    npm_config_userconfig: join(tmp, 'npmrc'),
    npm_config_cache: join(tmp, 'npm-cache'),
    npm_config_update_notifier: 'false',
  };
  // A timeout of its own: a synchronous call blocks the event loop, so --test-timeout can’t end a hung npm.
  const npm = (args) => execFileSync('npm', args, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  packed = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp]))[0];
  npm(['install', '--prefix', prefix, '--omit=optional', '--no-save', '--no-package-lock', '--offline', '--no-audit', '--no-fund', join(tmp, packed.filename)]);
  bin = join(prefix, 'node_modules', '.bin', 'postbox');
});
after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('ships only bin/, app/, server/, shared/ and the docs, with what runs, and none of the rest', () => {
  const files = packed.files.map((f) => f.path);
  const allowed = new Set(['bin', 'app', 'server', 'shared', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
  assert.deepEqual(
    [...new Set(files.map((f) => f.split('/')[0]))].filter((t) => !allowed.has(t)),
    [],
  );
  for (const must of ['bin/postbox.mjs', 'app/index.html', 'server/index.mjs', 'server/home.mjs', 'app/media/favicon.svg'])
    assert.ok(files.includes(must), `the package has ${must}`);
  assert.deepEqual(
    files.filter((f) => /(^|\/)(data|uat-runs|tests|tools|designs|mockups|screenshots)\//.test(f)),
    [],
    'nothing of data/, uat-runs/, tests, tools, designs, mockups or screenshots ships',
  );
});

test('carries the commit it was packed from, and leaves no commit file behind in the clone', () => {
  if (headCommit()) assert.ok(packed.files.some((f) => f.path === 'server/build-commit.txt'));
  assert.equal(existsSync(join(ROOT, 'server', 'build-commit.txt')), false);
});

test('installs a postbox command whose --help says how to run it, and --version prints the version', () => {
  assert.ok(existsSync(bin), 'installing gives a postbox command');
  const help = execFileSync(bin, ['--help'], { cwd, env: runEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.ok(/^Usage: postbox/.test(help) && help.includes('--port') && help.includes('--data'), help);
  assert.equal(execFileSync(bin, ['--version'], { cwd, env: runEnv(), encoding: 'utf8', timeout: 10_000 }).trim(), version);
});

test('serves the page, its media and the build line, and writes only under HOME/.postbox', async () => {
  const port = await freePort();
  const was = { home: await snapshot(home), prefix: await snapshot(prefix), cwd: await snapshot(cwd) };
  const server = spawn(bin, ['--port', String(port)], { cwd, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((ok) => server.once('exit', ok));
  try {
    const out = await running(server);
    assert.ok(out.includes(`Data: ${join(home, '.postbox')}`), `it says its data is in HOME/.postbox:\n${out}`);
    const origin = `http://127.0.0.1:${port}`;
    const page = await fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('<html'), 'it serves the page at /');
    assert.equal((await fetch(`${origin}/media/favicon.svg`)).status, 200, 'it serves the bundled media');
    const { config } = await fetch(`${origin}/api/state`).then((r) => r.json());
    assert.deepEqual([config.build?.version, config.build?.commit], [version, headCommit()], 'the build line shows the version and the commit');
  } finally {
    server.kill('SIGTERM');
    await exited;
  }
  const inHome = changed(was.home, await snapshot(home));
  assert.ok(inHome.length > 0, 'it wrote something under HOME/.postbox');
  assert.deepEqual(
    inHome.filter((p) => p !== '.postbox' && !p.startsWith(`.postbox${sep}`)),
    [],
    'it wrote only under HOME/.postbox',
  );
  assert.ok(existsSync(join(home, '.postbox', 'media')), 'HOME/.postbox has the media folder agents copy images into');
  assert.deepEqual(changed(was.prefix, await snapshot(prefix)), [], 'it wrote nothing in the installed package');
  assert.deepEqual(changed(was.cwd, await snapshot(cwd)), [], 'it wrote nothing in the folder it was started from');
});
