// The persona sheet’s Skills list (#207, server/adapters/skill-config.mjs): Postbox’s skills, yours and the project’s
// from disk, named by their frontmatter or their folder, and your plugins’ from the last init. Read from a fake home,
// never the real one.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { POSTBOX_SKILLS, skillList, yourSkills } from '../server/adapters/skill-config.mjs';

/** A fake filesystem: each path’s text, and each folder’s entries from the paths under it. */
function fakeFs(files) {
  const read = async (p) => {
    if (!(p in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return files[p];
  };
  const list = async (dir) => {
    const subs = Object.keys(files)
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => p.slice(dir.length + 1).split('/')[0]);
    if (!subs.length) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return [...new Set(subs)];
  };
  return { read, list };
}

test('Postbox’s own skills are named postbox:<name>, starting with the visual explainer', () => {
  assert.ok(POSTBOX_SKILLS.includes('postbox:visual-explainer'));
});

test('yours and the project’s are read from disk, by frontmatter name or folder, and a folder without SKILL.md is skipped', async () => {
  const home = '/h';
  const fs = fakeFs({
    [join(home, '.claude/skills/grill/SKILL.md')]: '---\nname: grill-me\ndescription: x\n---\nbody',
    [join(home, '.claude/skills/plain/SKILL.md')]: 'no frontmatter',
    [join(home, '.claude/skills/empty/notes.md')]: 'not a skill',
    [join('/w', '.claude/skills/ship/SKILL.md')]: '---\ndescription: y\nname: "ship-it"\n---\n',
  });
  assert.deepEqual(await yourSkills('/w', { home, configDir: null, ...fs }), [
    { name: 'grill-me', scope: 'user' },
    { name: 'plain', scope: 'user' },
    { name: 'ship-it', scope: 'project' },
  ]);
  assert.deepEqual(await yourSkills(null, { home: '/nobody', configDir: null, ...fs }), [], 'nothing there is nothing listed');
  const moved = await yourSkills(null, { home, configDir: '/cfg', ...fakeFs({ '/cfg/skills/a/SKILL.md': '' }) });
  assert.deepEqual(moved, [{ name: 'a', scope: 'user' }], 'CLAUDE_CONFIG_DIR moves your skills folder');
});

test('the list puts Postbox’s first, takes only plugins’ skills from an init, and keeps one turned off that’s gone', () => {
  const list = skillList({
    found: [
      { name: 'grill-me', scope: 'user' },
      { name: 'grill-me', scope: 'project' },
    ],
    seen: ['grill-me', 'debug', 'design:design-critique', 'postbox:visual-explainer'],
    off: ['design:design-critique', 'old-skill'],
  });
  assert.deepEqual(list, [
    ...POSTBOX_SKILLS.map((name) => ({ name, scope: 'postbox', off: false })),
    { name: 'grill-me', scope: 'project', off: false },
    { name: 'design:design-critique', scope: 'plugin', off: true },
    { name: 'old-skill', scope: 'unknown', off: true },
  ]);
});
