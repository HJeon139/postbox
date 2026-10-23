// A check of Postbox as an installed npm package (#157, #90), no Chrome needed:
// - `npm pack` ships what runs (bin/, app/, server/, shared/ and the docs), with the commit it was packed from, and
//   nothing of data/, uat-runs/, the tests, the tools, the designs, the mockups or the screenshots;
// - the tarball installs into a temp prefix, and `postbox --help` and `--version` answer;
// - `postbox --port <port>`, with HOME pointed at a temp folder, serves `/` and the build line (version and commit), and
//   writes only under HOME/.postbox: not in the package, not in the folder it was started from, nowhere else in HOME.
//
//   node tools/check-install.mjs
//
// Everything happens in a temp folder. The install is a project install into the prefix, offline and without the
// optional packages (the Agent SDK and Kokoro, about 750 MB): npm ignores --omit=optional for a global install. Its
// `postbox` is still npm’s link to bin/postbox.mjs, as a global install’s is. PB_PORT moves it (4760 by default), so
// sessions working in parallel don’t collide.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, ports, record } from './harness.mjs';

const { PORT } = await ports(4760, 9960);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tmp = await mkdtemp(join(tmpdir(), 'pb-check-install-'));
const [home, prefix, cwd, cache] = ['home', 'prefix', 'cwd', 'npm-cache'].map((d) => join(tmp, d));
for (const d of [home, prefix, cwd]) await mkdir(d);

// Node’s own folder first, so `npm` and the bin’s `#!/usr/bin/env node` find this Node and not a version manager’s shim,
// which may not start under a temp HOME.
const PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`;
const npmEnv = { ...process.env, PATH, npm_config_cache: cache, npm_config_update_notifier: 'false' };
const npm = (args) => execFileSync('npm', args, { cwd: ROOT, env: npmEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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
const changed = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();

let server = null;
try {
  // ── What ships ──
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp]))[0];
  const files = packed.files.map((f) => f.path);
  const tops = new Set(files.map((f) => f.split('/')[0]));
  const allowed = new Set(['bin', 'app', 'server', 'shared', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
  record(
    [...tops].every((t) => allowed.has(t)),
    'the package ships only bin/, app/, server/, shared/ and the docs',
    [...tops].filter((t) => !allowed.has(t)).join(', '),
  );
  for (const must of ['bin/postbox.mjs', 'app/index.html', 'server/index.mjs', 'server/home.mjs', 'app/media/favicon.svg'])
    record(files.includes(must), `the package has ${must}`);
  record(
    !files.some((f) => /(^|\/)(data|uat-runs|tests|tools|designs|mockups|screenshots)\//.test(f)),
    'nothing of data/, uat-runs/, tests, tools, designs, mockups or screenshots ships',
  );
  const commit = (() => {
    try {
      return git(['rev-parse', '--short=7', 'HEAD']);
    } catch {
      return null;
    }
  })();
  if (commit) record(files.includes('server/build-commit.txt'), 'the package carries the commit it was packed from');
  record(!existsSync(join(ROOT, 'server', 'build-commit.txt')), 'packing leaves no commit file behind in the clone');

  // ── Installed ──
  npm(['install', '--prefix', prefix, '--omit=optional', '--no-save', '--no-package-lock', '--offline', '--no-audit', '--no-fund', join(tmp, packed.filename)]);
  const bin = join(prefix, 'node_modules', '.bin', 'postbox');
  record(existsSync(bin), 'installing gives a postbox command');
  const runEnv = { PATH, HOME: home, POSTBOX_BACKENDS: 'mock' };
  const help = execFileSync(bin, ['--help'], { cwd, env: runEnv, encoding: 'utf8' });
  record(/^Usage: postbox/.test(help) && help.includes('--port') && help.includes('--data'), 'postbox --help says how to run it', help);
  const said = execFileSync(bin, ['--version'], { cwd, env: runEnv, encoding: 'utf8' }).trim();
  record(said === version, 'postbox --version prints the package’s version', said);

  // ── Running ──
  const before = { home: await snapshot(home), prefix: await snapshot(prefix), cwd: await snapshot(cwd) };
  let out = '';
  server = spawn(bin, ['--port', String(PORT)], { cwd, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => {
    out += d;
  });
  server.stderr.on('data', (d) => {
    out += d;
  });
  const exited = new Promise((ok) => server?.once('exit', ok));
  const origin = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100 && !out.includes('Postbox is running'); i++) await new Promise((ok) => setTimeout(ok, 100));
  record(out.includes(`Data: ${join(home, '.postbox')}`), 'it says its data is in HOME/.postbox', out);
  const page = await fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } });
  record(page.status === 200 && (await page.text()).includes('<html'), 'it serves the page at /', `status ${page.status}`);
  const media = await fetch(`${origin}/media/favicon.svg`);
  record(media.status === 200, 'it serves the bundled media', `status ${media.status}`);
  const { config } = await fetch(`${origin}/api/state`).then((r) => r.json());
  record(
    config.build?.version === version && config.build?.commit === commit,
    'the build line shows the version and the commit it was packed from',
    JSON.stringify(config.build),
  );
  server.kill('SIGTERM');
  await exited;
  server = null;
  const after = { home: await snapshot(home), prefix: await snapshot(prefix), cwd: await snapshot(cwd) };
  const inHome = changed(before.home, after.home);
  record(
    inHome.length > 0 && inHome.every((p) => p === '.postbox' || p.startsWith(`.postbox${sep}`)),
    'it wrote only under HOME/.postbox',
    inHome.filter((p) => !p.startsWith('.postbox')).join('\n') || 'nothing was written',
  );
  record(existsSync(join(home, '.postbox', 'media')), 'HOME/.postbox has the media folder agents copy images into');
  const inPrefix = changed(before.prefix, after.prefix);
  record(!inPrefix.length, 'it wrote nothing in the installed package', inPrefix.join('\n'));
  const inCwd = changed(before.cwd, after.cwd);
  record(!inCwd.length, 'it wrote nothing in the folder it was started from', inCwd.join('\n'));
} finally {
  server?.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
}
finish();
