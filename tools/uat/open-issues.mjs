// The repository’s open issues, so the tester and the report can name the ones a run catches again
// (tools/uat-run.mjs). It asks `gh`, and gives none when `gh` fails, so a run without GitHub still runs.

import { spawnSync } from 'node:child_process';

/** The open issues, by number and title, or none when `gh` fails. @param {string} root */
export function openIssues(root) {
  const gh = spawnSync('gh', ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title'], { cwd: root, encoding: 'utf8' });
  return gh.status === 0 ? JSON.parse(gh.stdout) : [];
}
