// Runs every headless Chrome check in parallel and sums them up (#159). The checks are found by name, so a new
// tools/check-*.mjs or tools/checks/*.mjs is picked up without a change here.
//
//   npm run check:browser                          every check, 4 at a time
//   node tools/check-all.mjs header shell          only the checks whose name has one of these in it
//   node tools/check-all.mjs --jobs 2 --timeout 300 --logs check-logs
//   node tools/check-all.mjs --lag 300                every server holds its events back 300 ms, as a busy runner can
//
// Each check runs in its own process, spawned with an argument array (no shell) and in its own process group,
// with a Postbox port pair (PB_PORT and the port after it) and a Chrome port (PB_CHROME_PORT), picked at random
// from 20000–32000 and checked free first, so two runs at once don’t collide. A check still running at its
// timeout (600 s by default) is killed with everything it started. Each check reports through tools/harness.mjs,
// and its full output is kept in the logs folder (a new one in the temp directory, unless --logs names one).
// Exits 1 when any check failed.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = fileURLToPath(new URL('.', import.meta.url));

/** Every check under tools, by name (check-contract, checks/menus), whose name has one of the filters in it. */
export async function discover(tools = TOOLS, filters = []) {
  const top = (await readdir(tools)).filter((f) => /^check-.+\.mjs$/.test(f) && f !== 'check-all.mjs').map((f) => f.slice(0, -4));
  const nested = (await readdir(join(tools, 'checks')).catch(() => [])).filter((f) => f.endsWith('.mjs')).map((f) => `checks/${f.slice(0, -4)}`);
  const all = [...top, ...nested].sort();
  return filters.length ? all.filter((n) => filters.some((f) => n.includes(f))) : all;
}

/**
 * What a finished check comes to: whether it passed, its counts, and the first thing that went wrong. Its
 * results file decides, when it wrote one; otherwise it died before it could (a crash, or killed at its timeout).
 */
export function verdict({ code, signal = null, timedOut = false, timeout = 0, results = null, log = '' }) {
  if (timedOut) return { ok: false, passed: results?.passed ?? 0, failed: (results?.failed ?? 0) + 1, first: `timed out after ${timeout} s, and was killed` };
  if (!results) {
    const last = log.trim().split('\n').filter(Boolean).at(-1) ?? '';
    const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
    return { ok: false, passed: 0, failed: 1, first: `${how} before it reported${last ? `: ${last.trim()}` : ''}` };
  }
  // A check that recorded nothing checked nothing, whatever its exit code (designs/developing.md, “Degenerate values”).
  if (!results.cases.length) return { ok: false, passed: 0, failed: 1, first: 'it recorded no cases, so it checked nothing' };
  const bad = results.cases.find((c) => !c.ok);
  const first = bad ? `${bad.name}${bad.detail ? ` (${bad.detail.split('\n')[0]})` : ''}` : code ? `exited with code ${code}` : '';
  return { ok: code === 0 && !results.failed, passed: results.passed, failed: results.failed, first };
}

/** Whether nothing listens on a port of 127.0.0.1. */
const free = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

// Ports are picked at random below the ephemeral ranges (49152 up on macOS, 32768 up on Linux): the system hands
// those out in order to anything that asks for port 0, so a port picked there could be given away before the
// check binds it, and the port after it (a check’s second server) is the next one handed out.
const LOW = 20000;
const HIGH = 32000;
const taken = new Set();
/** A free Postbox port whose next port is free too (a check may start a second server there), and a Chrome port. */
async function portsFor() {
  const pick = () => LOW + Math.floor(Math.random() * (HIGH - LOW - 1));
  for (let i = 0; i < 100; i++) {
    const [port, chrome] = [pick(), pick()];
    const want = [port, port + 1, chrome];
    if (new Set(want).size < 3 || want.some((p) => taken.has(p))) continue;
    if (!(await free(port)) || !(await free(port + 1)) || !(await free(chrome))) continue;
    for (const p of want) taken.add(p);
    return { port, chrome };
  }
  throw new Error('Couldn’t find free ports for a check.');
}

/** Signals a check’s whole process group (it, its Chrome, anything it spawned), or the check alone where groups don’t exist. */
function signalGroup(child, sig) {
  try {
    process.kill(-(/** @type {number} */ (child.pid)), sig);
  } catch {
    try {
      child.kill(sig);
    } catch {}
  }
}

const running = new Set();

async function run(name, { logs, timeout, lag }) {
  const { port, chrome } = await portsFor();
  const file = name.replace('/', '-');
  const resultsFile = join(logs, `${file}.json`);
  const logFile = join(logs, `${file}.log`);
  // A results file left from an earlier run in the same folder mustn’t pass for this one.
  await rm(resultsFile, { force: true });
  const out = createWriteStream(logFile);
  const started = Date.now();
  const child = spawn(process.execPath, [join(TOOLS, `${name}.mjs`)], {
    cwd: resolve(TOOLS, '..'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PB_PORT: String(port),
      PB_CHROME_PORT: String(chrome),
      PB_CHECK_RESULTS: resultsFile,
      ...(lag ? { POSTBOX_STREAM_LAG: String(lag) } : {}),
    },
  });
  running.add(child);
  let tail = '';
  const keep = (chunk) => {
    out.write(chunk);
    tail = (tail + chunk).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let timedOut = false;
  // SIGTERM first, so the check can close its Chrome; then SIGKILL for anything still there.
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup(child, 'SIGTERM');
    setTimeout(() => signalGroup(child, 'SIGKILL'), 5000).unref();
  }, timeout * 1000);
  const closed = new Promise((ok) => child.once('close', ok));
  const { code, signal } = await new Promise((ok) => {
    child.once('error', (e) => {
      keep(`${e.message}\n`);
      ok({ code: 1, signal: null });
    });
    child.once('exit', (c, s) => ok({ code: c, signal: s }));
  });
  clearTimeout(timer);
  // A check that exits without closing its Chrome mustn’t leave it running, nor anything else it started that
  // still holds its output open.
  signalGroup(child, 'SIGKILL');
  if (child.pid) await closed;
  running.delete(child);
  for (const p of [port, port + 1, chrome]) taken.delete(p);
  await new Promise((ok) => out.end(ok));
  const results = await readFile(resultsFile, 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => null);
  return { name, seconds: Math.round((Date.now() - started) / 1000), log: logFile, ...verdict({ code, signal, timedOut, timeout, results, log: tail }) };
}

/** The value after a flag, as a positive number when asked. */
function option(args, flag, fallback, { number = true } = {}) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  if (!number) return value;
  const n = Number(value);
  if (!(n > 0)) throw new Error(`${flag} takes a positive number, not “${value ?? ''}”.`);
  return n;
}

async function main(argv) {
  const args = [...argv];
  const jobs = option(args, '--jobs', 4);
  const timeout = option(args, '--timeout', 600);
  const lag = option(args, '--lag', 0);
  const logsArg = option(args, '--logs', null, { number: false });
  const names = await discover(TOOLS, args);
  if (!names.length) {
    console.error(`No check matches ${args.join(', ')}.`);
    process.exit(1);
  }
  const logs = logsArg ? resolve(logsArg) : await mkdtemp(join(tmpdir(), 'pb-checks-'));
  await mkdir(logs, { recursive: true });
  console.log(`${names.length} headless checks, ${jobs} at a time, ${timeout} s each at most${lag ? `, events held back ${lag} ms` : ''}.\n`);

  // Ctrl-C reaches only this process (the checks have their own groups), so pass it on before leaving.
  process.once('SIGINT', () => {
    for (const child of running) signalGroup(child, 'SIGKILL');
    process.exit(130);
  });

  const queue = [...names];
  const done = [];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const r = await run(name, { logs, timeout, lag });
      done.push(r);
      const counts = `${r.passed} passed${r.failed ? `, ${r.failed} failed` : ''}, ${r.seconds} s`;
      console.log(r.ok ? `  ok    ${name} (${counts})` : `  FAIL  ${name} (${counts})\n        ${r.first}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));

  const bad = done.filter((r) => !r.ok);
  console.log(`\n${done.length - bad.length} passed, ${bad.length} failed.`);
  for (const r of bad) console.log(`  ${r.name}: ${r.log}`);
  console.log(`Logs: ${logs}`);
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
