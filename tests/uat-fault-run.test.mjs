// The runner's side of the fault launcher (#508, tools/uat/fault-run.mjs): a scenario whose phases say
// `- fault: fail-before-output <agent> <n>` starts Postbox with the launcher in front of that agent's backend, and
// the phase that names the fault arms it, through the file the launcher reads at each start.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { armed } from '../tools/uat/fault-launcher.mjs';
import { faultSetup } from '../tools/uat/fault-run.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = join(ROOT, 'tools', 'uat', 'fault-launcher.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'pb-fault-run-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let runs = 0;
const runDir = () => join(tmp, `run-${++runs}`);

const scenario = (header, fault = 'fail-before-output researcher 1') =>
  parseScenario(
    [
      '# Faults',
      '- agents: researcher, critic',
      header,
      '',
      'A summary.',
      '',
      '## Phase 1: Before',
      '- triggers: held-behind-card',
      '',
      'Nothing fails yet.',
      '',
      '## Phase 2: The fault',
      `- fault: ${fault}`,
      '- triggers: fail-before-output',
      '',
      'Its first turn fails.',
      '',
      '## Phase 3: After',
      '- triggers: resend-labeled',
      '',
      'Nothing fails again.',
    ].join('\n'),
  );

test('a scenario with no fault starts Postbox as it always has', () => {
  assert.equal(faultSetup({ scenario: parseScenario('# T\n- agents: researcher\n\n## Phase 1: A\n\nText.'), root: ROOT, dir: runDir(), env: {} }), null);
});

test('a fault on a Claude Code agent puts the launcher in front of Claude Code, with the real CLI behind it', () => {
  const dir = runDir();
  const f = faultSetup({ scenario: scenario(''), root: ROOT, dir, env: { POSTBOX_CLAUDE_BIN: '/opt/claude/bin/claude', POSTBOX_UAT_FAULT: 'stale' } });
  assert.ok(f);
  assert.equal(f.env.POSTBOX_CLAUDE_BIN, LAUNCHER);
  assert.equal(f.env.POSTBOX_UAT_REAL_BIN, '/opt/claude/bin/claude');
  assert.ok(f.env.POSTBOX_UAT_FAULT_FILE.startsWith(dir));
  assert.ok(f.env.POSTBOX_UAT_FAULT_STATE.startsWith(dir));
  assert.equal(f.env.POSTBOX_UAT_FAULT, '', 'a fault set outside the run would override the phases’');
  for (const v of ['POSTBOX_CODEX_BIN', 'POSTBOX_KIRO_BIN', 'POSTBOX_AGY_BIN']) assert.equal(f.env[v], undefined, v);
});

test('a fault on an agent the scenario puts on another backend puts the launcher in front of that one', () => {
  const cases = [
    ['codex', 'POSTBOX_CODEX_BIN', { POSTBOX_CODEX_BIN: '/x/codex' }, '/x/codex'],
    ['kiro-cli', 'POSTBOX_KIRO_BIN', {}, 'kiro-cli'],
    ['antigravity-cli', 'POSTBOX_AGY_BIN', {}, 'agy'],
  ];
  for (const [backend, bin, env, real] of cases) {
    const f = faultSetup({ scenario: scenario(`- backends: researcher=${backend}`), root: ROOT, dir: runDir(), env });
    assert.equal(f?.env[bin], LAUNCHER, backend);
    assert.equal(f?.env.POSTBOX_UAT_REAL_BIN, real, backend);
    assert.equal(f?.env.POSTBOX_CLAUDE_BIN, undefined, `${backend}: Claude Code’s agents keep their own CLI`);
  }
});

test('a fault line the launcher can’t read, or faults on two backends, stop the run before it starts', () => {
  assert.throws(() => faultSetup({ scenario: scenario('', 'fail-after-output researcher 1'), root: ROOT, dir: runDir(), env: {} }), /fail-after-output/);
  const two = scenario('- backends: critic=codex');
  two.phases[2].fault = 'fail-before-output critic 1';
  assert.throws(() => faultSetup({ scenario: two, root: ROOT, dir: runDir(), env: {} }), /one backend/);
});

test('the phase that names the fault arms it, and the next phase disarms it', () => {
  const f = faultSetup({ scenario: scenario(''), root: ROOT, dir: runDir(), env: {} });
  assert.ok(f);
  const env = f.env;
  assert.equal(armed(env), null, 'nothing is armed before phase 2');
  f.arm(0);
  assert.equal(armed(env), null);
  f.arm(1);
  assert.deepEqual(armed(env), { kind: 'fail-before-output', agent: 'researcher', n: 1, line: 'fail-before-output researcher 1' });
  f.arm(1);
  assert.equal(armed(env)?.agent, 'researcher', 'arming the same phase again leaves it armed');
  f.arm(2);
  assert.equal(armed(env), null);
});

test('#508’s delivery and bigroom scenarios parse: the big-room seed, phase 3’s fault, and the triggers that exist', () => {
  const read = (name) => parseScenario(readFileSync(join(ROOT, 'tests', 'uat', 'e2e', 'scenarios', `${name}.md`), 'utf8'));
  const delivery = read('delivery');
  const bigroom = read('bigroom');
  assert.equal(delivery.seed, 'big-room');
  assert.equal(bigroom.seed, 'big-room');
  assert.deepEqual([delivery.phases.length, bigroom.phases.length], [7, 4]);
  assert.deepEqual(
    delivery.phases.map((p) => p.fault),
    [null, null, 'fail-before-output researcher 1', null, null, null, null],
  );
  assert.equal(faultSetup({ scenario: delivery, root: ROOT, dir: runDir(), env: {} })?.env.POSTBOX_CLAUDE_BIN, LAUNCHER);
  assert.equal(faultSetup({ scenario: bigroom, root: ROOT, dir: runDir(), env: {} }), null);
  assert.equal(delivery.phases[5].host, 'developer');
  assert.deepEqual(delivery.phases[5].hostTriggers, ['wake-scheduled', 'wake-after-drop']);
  assert.match(delivery.phases[5].hostText, /drops the host’s link/);
  // Phases 1 to 3 use the triggers this step adds (tools/uat/delivery-triggers.mjs); the rest come with later steps.
  assert.deepEqual(unknownTriggers({ phases: delivery.phases.slice(0, 3) }), []);
});
