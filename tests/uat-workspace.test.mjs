// A run's workspace lies inside the Postbox checkout, whose AGENTS.md are the rules for developing Postbox (#315).
// Claude Code reads every AGENTS.md from an agent's folder up, so the workspace's own settings exclude them.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hideSteeringAbove, steeringAbove } from '../tools/uat/workspace.mjs';

/** A checkout with its own AGENTS.md, and a run's workspace inside it that git has made a repository. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'pb-uat-ws-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Working on Postbox\n');
  const workspace = join(root, 'uat-runs', 'run-1', 'workspace');
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  writeFileSync(join(workspace, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
  return { root, workspace };
}

test('a run’s workspace excludes every AGENTS.md above it, by its path and its real path, and git ignores the settings', () => {
  const { root, workspace } = checkout();
  try {
    hideSteeringAbove(workspace);
    const { claudeMdExcludes } = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'));
    for (const top of new Set([root, realpathSync(root)])) {
      assert.ok(claudeMdExcludes.includes(join(top, 'AGENTS.md')), `excludes ${join(top, 'AGENTS.md')}`);
      assert.ok(claudeMdExcludes.includes(join(top, '.claude', 'AGENTS.md')));
      assert.ok(claudeMdExcludes.includes(join(top, 'uat-runs', 'AGENTS.md')), 'and every folder’s between');
    }
    // The workspace's own steering, if a scenario seeds one, still loads.
    assert.ok(!claudeMdExcludes.some((p) => p.startsWith(`${workspace}/`) || p.startsWith(`${realpathSync(workspace)}/`)));
    assert.match(readFileSync(join(workspace, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/settings\.json$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace that already has project settings keeps them, with the excludes beside them', () => {
  const { root, workspace } = checkout();
  try {
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(npm test)"]}}\n');
    hideSteeringAbove(workspace);
    const settings = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.deepEqual(settings.claudeMdExcludes, steeringAbove(workspace));
    assert.ok(settings.claudeMdExcludes.includes(join(root, 'AGENTS.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
