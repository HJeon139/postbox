// The fault launcher (#508, tools/uat/fault-launcher.mjs) in front of a stand-in CLI: the turn it fails passes the
// first session event through and nothing after it, and exits 1; a turn it doesn’t fail passes everything. The
// stand-in writes the first line of a recorded Claude Code turn that carries its init (tests/fixtures/claude-code/
// background-failed.jsonl), then, a moment later, an assistant message. The last test arms it as the runner does, through
// tools/uat/fault-run.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { faultSetup } from '../../tools/uat/fault-run.mjs';
import { parseScenario } from '../../tools/uat/scenario.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pb-fault-launcher-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const init = readFileSync(join(ROOT, 'tests/fixtures/claude-code/background-failed.jsonl'), 'utf8')
  .split('\n')
  .find((l) => l.includes('"subtype":"init"'));
const cli = join(dir, 'cli.mjs');
writeFileSync(
  cli,
  `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${init}\n`)});\nsetTimeout(() => { process.stdout.write('{"type":"assistant","message":{"content":[]}}\\n'); }, 300);\n`,
);
chmodSync(cli, 0o755);

/** Runs the launcher as the researcher’s turn, with a timeout. @param {Record<string, string>} env */
function turn(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [join(ROOT, 'tools/uat/fault-launcher.mjs'), '-p', '--append-system-prompt', 'You are @researcher, an agent in Postbox.'],
      {
        env: { PATH: process.env.PATH, POSTBOX_UAT_REAL_BIN: cli, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('The launcher didn’t exit within 10 seconds.'));
    }, 10_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        types: out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l).type),
      });
    });
  });
}

test('the faulted turn passes its session event through, then fails before any assistant output', async () => {
  const r = await turn({ POSTBOX_UAT_FAULT: 'fail-before-output researcher 1', POSTBOX_UAT_FAULT_STATE: join(dir, 'a') });
  assert.deepEqual(r, { code: 1, types: ['system'] });
});

test('a turn without a fault passes the whole stream through and exits as the CLI did', async () => {
  const r = await turn({});
  assert.deepEqual(r, { code: 0, types: ['system', 'assistant'] });
});

test('a fault the runner arms as its phase starts fails the next turn, and none after the phase ends', async () => {
  const s = parseScenario(
    '# T\n- agents: researcher\n\n## Phase 1: A\n\nText.\n\n## Phase 2: B\n- fault: fail-before-output researcher 1\n\nText.\n\n## Phase 3: C\n\nText.',
  );
  const f = faultSetup({ scenario: s, root: ROOT, dir: join(dir, 'run'), env: {} });
  assert.ok(f);
  const env = { ...f.env, POSTBOX_UAT_REAL_BIN: cli };
  f.arm(0);
  assert.deepEqual(await turn(env), { code: 0, types: ['system', 'assistant'] });
  f.arm(1);
  assert.deepEqual(await turn(env), { code: 1, types: ['system'] });
  assert.deepEqual(await turn(env), { code: 0, types: ['system', 'assistant'] }, 'only its first turn');
  f.arm(2);
  assert.deepEqual(await turn(env), { code: 0, types: ['system', 'assistant'] });
});
