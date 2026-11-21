// A UAT run’s ATIF export (tools/uat/run-atif.mjs), which tools/uat-run.mjs calls once the run’s report, verdicts and
// run.json are written: it reads the run’s saved history and its data folder’s prompts.jsonl, and an export that fails
// is logged and left in atif/export-error.txt, never thrown, so it can’t lose what the run cost (#1529). Built from
// the recorded run in tests/fixtures/atif/dry-run.md.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeTrajectories } from '../tools/atif-export.mjs';
import { exportTrajectories } from '../tools/uat/run-atif.mjs';
import { tempDir } from './temp-dirs.mjs';

const FIXTURE = new URL('fixtures/atif/dry-run/', import.meta.url).pathname;

/** A run folder as writeHistory leaves one, with Postbox’s data folder holding prompts.jsonl, where a run records it. */
function runFolder() {
  const dir = tempDir('pb-uat-atif-');
  cpSync(FIXTURE, dir, { recursive: true });
  mkdirSync(join(dir, 'data'));
  renameSync(join(dir, 'prompts.jsonl'), join(dir, 'data', 'prompts.jsonl'));
  return dir;
}

test('a run’s export writes each agent’s trajectory, with the prompts its data folder recorded', () => {
  const dir = runFolder();
  const said = [];
  const files = exportTrajectories(dir, (l) => said.push(l));
  assert.deepEqual(readdirSync(join(dir, 'atif')).sort(), ['dry-se_BW6DwWCC.atif.json', 'dry2-se_lmBsdwcV.atif.json']);
  assert.equal(files.length, 2);
  const t = JSON.parse(readFileSync(join(dir, 'atif', 'dry-se_BW6DwWCC.atif.json'), 'utf8'));
  assert.equal(t.extra.scope.record, 'postbox-conversation-and-prompts');
  assert.equal(existsSync(join(dir, 'prompts.jsonl')), false, 'read from the data folder');
  assert.match(said[0], /^ATIF: 2 trajectories in /);
});

test('an export that fails is logged and left in the run’s atif folder, and never thrown', () => {
  const dir = runFolder();
  // An item with no `at`, which a step’s timestamp can’t be made from: the export itself throws on it.
  const bad = { seq: 999, type: 'item.add', data: { threadId: 'th_9rDc0zBs', item: { id: 'it_bad', kind: 'agent', sessionId: 'se_BW6DwWCC', text: 'x' } } };
  writeFileSync(join(dir, 'events.jsonl'), `${readFileSync(join(dir, 'events.jsonl'), 'utf8')}${JSON.stringify(bad)}\n`);
  assert.throws(() => writeTrajectories(join(dir, 'raw'), { events: [bad] }), RangeError);
  const said = [];
  assert.deepEqual(
    exportTrajectories(dir, (l) => said.push(l)),
    [],
  );
  assert.match(
    said[0],
    /^The run’s ATIF export failed: Invalid time value\. Its report and findings are written; to try again, run node tools\/atif-export\.mjs /,
  );
  const left = readFileSync(join(dir, 'atif', 'export-error.txt'), 'utf8');
  assert.ok(left.startsWith(said[0]));
  assert.equal(existsSync(join(dir, 'atif', 'dry-se_BW6DwWCC.atif.json')), false);
});
