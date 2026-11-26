// The project’s nightly check: it runs the tests some minutes after it’s queued for a commit, and tells nobody when
// it’s finished.
//   node nightly.mjs queue    queues the check for the commit at HEAD
//   node nightly.mjs status   says whether it’s still running, and how it went once it’s finished

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long the check takes from the moment it’s queued: longer than one shell command may run in an agent’s turn. */
const TAKES_MS = 720_000;

/** What a git command printed, or null when it failed. @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Where the queued check is kept: inside the repository’s one .git, so the working tree stays clean and a linked worktree shares it. */
function recordPath() {
  const dir = git(['rev-parse', '--git-common-dir']);
  return dir ? join(dir, 'nightly.json') : null;
}

/** Keeps a line of what the check did and when, beside its record: its own history, whoever asked. @param {object} line */
function log(line) {
  const path = recordPath();
  if (path) appendFileSync(path.replace(/nightly\.json$/, 'nightly-log.jsonl'), `${JSON.stringify({ at: Date.now(), ...line })}\n`);
}

function queue() {
  const commit = git(['rev-parse', '--short', 'HEAD']);
  const path = recordPath();
  if (!commit || !path) return 'NIGHTLY REFUSED: there is no commit to check. Commit the work, then queue it again.';
  const at = Date.now();
  const due = at + TAKES_MS;
  writeFileSync(path, JSON.stringify({ commit, due }));
  log({ at, did: 'queued', commit, due });
  return [
    `NIGHTLY QUEUED commit=${commit} due=${new Date(due).toISOString()}`,
    `It takes about ${TAKES_MS / 60_000} minutes and runs by itself. Nothing tells you when it has finished: ask with “node nightly.mjs status”.`,
  ].join('\n');
}

/** Runs the project’s tests, and says how they went on that commit. @param {string} commit */
function result(commit) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { encoding: 'utf8' });
  const passed = /^# pass (\d+)$/m.exec(r.stdout ?? '')?.[1] ?? '0';
  const ok = r.status === 0 && passed !== '0';
  log({ did: ok ? 'passed' : 'failed', commit });
  if (ok) return `NIGHTLY PASSED commit=${commit} tests=${passed}`;
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
  return `NIGHTLY FAILED commit=${commit}\n${tail}`;
}

function status() {
  const path = recordPath();
  if (!path || !existsSync(path)) return 'NIGHTLY NOT QUEUED: queue it with “node nightly.mjs queue”.';
  const { commit, due } = JSON.parse(readFileSync(path, 'utf8'));
  const left = Math.ceil((due - Date.now()) / 1000);
  if (left > 0) return `NIGHTLY RUNNING commit=${commit} left=${left}s`;
  return result(commit);
}

const command = process.argv[2];
if (command === 'queue') console.log(queue());
else if (command === 'status') console.log(status());
else console.log('Usage: node nightly.mjs queue | status');
