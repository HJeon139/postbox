// `- skills: off` (#206): a baseline runs its Claude agents without Postbox’s own skills (server/adapters/agent-plugin.mjs),
// which every other run has by default, so it can be compared with the run that has them.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { telemetryEnv } from '../tools/uat/telemetry-run.mjs';

const DIR = join(import.meta.dirname, 'uat', 'e2e', 'scenarios');
const read = (name) => parseScenario(readFileSync(join(DIR, name), 'utf8'));

test('`- skills: off` starts Postbox with POSTBOX_AGENT_SKILLS=off, and a scenario without it leaves the skills on', () => {
  const off = read('everyday-subs-base.md');
  assert.equal(off.skills, 'off');
  assert.equal(telemetryEnv(off, '/run', { telemetry: 'no' }).POSTBOX_AGENT_SKILLS, 'off');
  const on = read('everyday-subs.md');
  assert.equal(on.skills, 'on');
  assert.equal('POSTBOX_AGENT_SKILLS' in telemetryEnv(on, '/run', { telemetry: 'no' }), false);
});

test('every baseline of a run with the skill runs without it, and the run it’s compared with has it', () => {
  const names = readdirSync(DIR);
  const pairs = [
    ...names.filter((n) => n.endsWith('-base.md')).map((n) => [n, n.replace('-base.md', '.md')]),
    ['trial-c2.md', 'trial-c1.md'],
    ...['madeddu', 'jia', 'sontag'].map((p) => [`visualpaper-${p}.md`, `visualpaper-${p}-skill.md`]),
  ];
  assert.equal(pairs.length, 15);
  for (const [base, withSkill] of pairs) {
    assert.equal(read(base).skills, 'off', base);
    assert.equal(read(withSkill).skills, 'on', withSkill);
  }
});
