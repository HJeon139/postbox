// POSTBOX_CHAIN_LIMIT (#508, tests/uat-chain-limit.test.mjs): a Postbox started under it enforces that chain limit and
// tells agents that number; without it, the backstop of 50 (#541); with a value that isn’t a whole number from 1 to 50, it
// refuses to start. Each case is a process of its own, since the module reads the variable once, when it loads.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pb-chain-limit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a module script in a Node process at ROOT, with POSTBOX_CHAIN_LIMIT set or not. */
function node(args, env, { input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: dir, ...env },
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input) p.stdin.end(input);
  });
}

// Three wakes between two agents, then a fourth: what the limit does with it, as a line of JSON.
const CHAIN = `
import { HOP_LIMIT } from './shared/limits.mjs';
import { TOOL_DEFS } from './shared/mcp-tools.mjs';
import { setup } from './tests/side-threads-fixture.mjs';
const f = setup();
const results = [];
for (let i = 0; i < 4; i++) {
  const [from, to] = i % 2 ? [f.beta, 'alpha'] : [f.alpha, 'beta'];
  results.push(f.rt.agentWake(from.id, to, 'hand-off ' + (i + 1)));
}
const card = f.store.items(f.t.id).find((x) => x.kind === 'hop') ?? null;
const told = TOOL_DEFS.find((d) => d.name === 'wake_agent').description.match(/After (\\d+) agent wakes in one chain/)?.[1];
console.log(JSON.stringify({ HOP_LIMIT, waiting: results.map((r) => r.waiting === true), n: card?.n ?? null, told }));
process.exit(0);
`;

test('under POSTBOX_CHAIN_LIMIT=3 the fourth wake in a chain waits on a card numbered 4, and wake_agent says 3', async () => {
  const r = await node(['--input-type=module', '-e', CHAIN], { POSTBOX_CHAIN_LIMIT: '3' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out.trim()), { HOP_LIMIT: 3, waiting: [false, false, false, true], n: 4, told: '3' });
});

test('without the variable the backstop is 50: four wakes all go', async () => {
  const r = await node(['--input-type=module', '-e', CHAIN], {});
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out.trim()), { HOP_LIMIT: 50, waiting: [false, false, false, false], n: null, told: '50' });
});

test('a Postbox started with a bad POSTBOX_CHAIN_LIMIT refuses to start, and says what it takes', async () => {
  const r = await node([join(ROOT, 'server', 'index.mjs'), '--port', '0', '--data', join(dir, 'data'), '--fresh'], {
    POSTBOX_CHAIN_LIMIT: 'abc',
    POSTBOX_BACKENDS: 'mock',
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /POSTBOX_CHAIN_LIMIT/);
  assert.match(r.err, /whole number from 1/);
  assert.match(r.err, /“abc”/);
});
