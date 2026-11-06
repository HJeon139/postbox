// `- seed: visual-skill` (tools/uat/visual-skill.mjs): the agent under test gets the skill, and never the briefs that
// hold each test’s intended idea.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedVisualSkill } from '../tools/uat/visual-skill.mjs';

test('the visual-skill seed puts SKILL.md and its references where Claude Code finds project skills, without the briefs', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'pb-visual-skill-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const dest = seedVisualSkill(workspace);
  assert.equal(dest, join(workspace, '.claude', 'skills', 'visual-explainer'));
  assert.ok(existsSync(join(dest, 'SKILL.md')));
  assert.deepEqual(readdirSync(join(dest, 'references')).sort(), ['brief.md', 'critique.md', 'shapes.md']);
  assert.deepEqual(readdirSync(dest).sort(), ['SKILL.md', 'references'], 'no briefs and no README');
});
