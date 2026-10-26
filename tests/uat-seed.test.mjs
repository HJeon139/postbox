// The agents a UAT run seeds (tools/uat/seed.mjs): a scenario’s `- permission_modes:` reaches the agent it names on
// any backend. remotehosts’ @critic, on Claude Code, ran its first live run in auto, so its permission cards from a
// host never appeared (#120).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { seedAgents } from '../tools/uat/seed.mjs';

const ROOT = join(import.meta.dirname, '..');
const scenario = (name) => parseScenario(readFileSync(join(ROOT, 'tests', 'uat', 'e2e', 'scenarios', `${name}.md`), 'utf8'));

test('#120 a scenario’s permission mode reaches a Claude Code agent, not only one on another backend', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-uat-seed-'));
  try {
    const opt = { 'agent-model': 'claude-haiku-5-5', 'agent-effort': 'low' };
    await seedAgents({ scenario: scenario('remotehosts'), opt, root: ROOT, data, log: () => {} });
    const agents = JSON.parse(readFileSync(join(data, 'agents.json'), 'utf8'));
    const by = (h) => agents.find((p) => p.handle === h);
    assert.equal(by('critic').permissionMode, 'ask');
    assert.equal(by('critic').backend, undefined, 'still on Claude Code');
    assert.equal(by('researcher').permissionMode, undefined, 'an agent the line doesn’t name keeps its persona’s mode');
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
