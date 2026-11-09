// POSTBOX_CHAIN_LIMIT (#508, tests/uat-chain-limit.test.mjs): the server’s default chain limit. A Postbox started under
// it enforces that limit in a room with none of its own, and tells agents that number; a room set to its own (#1035)
// keeps it. Without the variable, the default is 1,000 (#1035); with a value that isn’t a whole number from 1 to 10,000,
// it refuses to start. Each case is a process of its own, since the module reads the variable once, when it loads.

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

// Wakes between two agents in a room with nothing set (four), and in a room set to 8 (nine): what the limit does with
// each, as a line of JSON.
const CHAIN = `
import { HOP_LIMIT } from './shared/limits.mjs';
import { TOOL_DEFS } from './shared/mcp-tools.mjs';
import { updateThread } from './server/thread-write.mjs';
import { setup } from './tests/side-threads-fixture.mjs';
const f = setup();
const own = f.rt.createThread({ projectId: 'p1', title: 'Own', personaIds: [f.a.id, f.b.id] });
updateThread(f.rt, own.id, { chainLimit: 8 });
const wakes = (threadId, n) => {
  const [alpha, beta] = f.rt.sessionsIn(threadId);
  const results = [];
  for (let i = 0; i < n; i++) {
    const [from, to] = i % 2 ? [beta, 'alpha'] : [alpha, 'beta'];
    results.push(f.rt.agentWake(from.id, to, 'hand-off ' + (i + 1)).waiting === true);
  }
  return { waiting: results, n: f.store.items(threadId).find((x) => x.kind === 'hop')?.n ?? null };
};
const told = TOOL_DEFS.find((d) => d.name === 'wake_agent').description.match(/the room’s chain limit of agent wakes in one chain \\(([\\d,]+) unless the person set another\\)/)?.[1];
console.log(JSON.stringify({ HOP_LIMIT, unset: wakes(f.t.id, 4), own: wakes(own.id, 9), told }));
process.exit(0);
`;
const goes = (n) => Array(n).fill(false);

test('under POSTBOX_CHAIN_LIMIT=3 an unset room’s fourth wake waits on a card numbered 4, a room set to 8 asks at its ninth, and wake_agent says 3', async () => {
  const r = await node(['--input-type=module', '-e', CHAIN], { POSTBOX_CHAIN_LIMIT: '3' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out.trim()), {
    HOP_LIMIT: 3,
    unset: { waiting: [...goes(3), true], n: 4 },
    own: { waiting: [...goes(8), true], n: 9 },
    told: '3',
  });
});

test('without the variable the default is 1,000: four wakes all go in an unset room, and wake_agent says 1,000', async () => {
  const r = await node(['--input-type=module', '-e', CHAIN], {});
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out.trim()), {
    HOP_LIMIT: 1000,
    unset: { waiting: goes(4), n: null },
    own: { waiting: [...goes(8), true], n: 9 },
    told: '1,000',
  });
});

test('POSTBOX_CHAIN_LIMIT can set the default as high as 10,000, but no higher', async () => {
  for (const limit of ['1000', '10000']) {
    const r = await node(['--input-type=module', '-e', CHAIN], { POSTBOX_CHAIN_LIMIT: limit });
    assert.equal(r.code, 0, `${limit}: ${r.err}`);
    assert.equal(JSON.parse(r.out.trim()).HOP_LIMIT, Number(limit));
  }
  const r = await node([join(ROOT, 'server', 'index.mjs'), '--port', '0', '--data', join(dir, 'data-high'), '--fresh'], {
    POSTBOX_CHAIN_LIMIT: '10001',
    POSTBOX_BACKENDS: 'mock',
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /POSTBOX_CHAIN_LIMIT takes a whole number from 1 to 10,000, not “10001”/);
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
