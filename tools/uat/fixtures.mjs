// `- files: subscriptions` (#206): copies a folder of tests/uat/e2e/fixtures/ into the run’s workspace before Postbox
// starts, so a scenario can ask about the person’s own data or code, the way people use Postbox, rather than only
// about an idea in the message. It combines with `- seed:`, so the same files can run with and without the
// visual-explainer skill. Only the folder’s contents are copied: the fixture’s name, and the brief that holds what a
// good answer shows, stay out of the agent’s sight.

import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, '..', '..', 'tests', 'uat', 'e2e', 'fixtures');

/** The fixture a scenario names, or null; a name with no folder is refused, not run without its files. @param {string|undefined} spec */
export function filesOf(spec, root = FIXTURES) {
  if (spec === undefined) return null;
  const name = String(spec).trim();
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(join(root, name))) {
    throw new Error(`- files names a folder in tests/uat/e2e/fixtures/, and there’s no “${name}”.`);
  }
  return name;
}

/** Copies the fixture’s contents into the workspace. @param {string} workspace @param {string} name @param {string} [root] */
export function seedFiles(workspace, name, root = FIXTURES) {
  cpSync(join(root, name), workspace, { recursive: true });
}
