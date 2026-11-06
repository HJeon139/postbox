// `- seed: visual-skill` (#207, #333): puts the draft visual-explainer skill in the workspace as a project skill, where
// Claude Code finds it at .claude/skills/, so a run can measure an agent with the skill against one without.
// Only what an agent would load: SKILL.md and its references. The starter briefs and the README stay out, because the
// briefs hold each test’s intended idea and traps, which the agent under test must not see.

import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join(import.meta.dirname, '..', '..', 'designs', 'skills', 'visual-explainer');

/** Copies the skill into the workspace. @param {string} workspace @param {string} [source] */
export function seedVisualSkill(workspace, source = SOURCE) {
  const dest = join(workspace, '.claude', 'skills', 'visual-explainer');
  mkdirSync(dest, { recursive: true });
  cpSync(join(source, 'SKILL.md'), join(dest, 'SKILL.md'));
  cpSync(join(source, 'references'), join(dest, 'references'), { recursive: true });
  return dest;
}
