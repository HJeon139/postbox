// The SkillSpector judge’s command line, as prompt-surface-scan.yml runs it: its exit code is the scan’s verdict, so a
// command line that printed nothing and exited 0 would pass every pull request. It runs node, which tests/guard.mjs
// keeps out of the unit tests, so it’s under tests/process/ (npm run test:process). Each case writes its findings to a
// fresh temp folder, and runs the judge there and through a symlink to it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const JUDGE = fileURLToPath(new URL('../../tools/prompt-findings.mjs', import.meta.url));
const PRINT = '58ad794262acddeb5ede92f20cb4814e3ac43a46c218604ec928af500aa80424';
const HIGH = {
  match_fingerprint: PRINT,
  severity: 'HIGH',
  id: 'PE3',
  category: 'Privilege Escalation',
  location: { file: 'repo/tests/AGENTS.md', start_line: 16 },
  finding: '~/.npmrc',
  explanation: 'Code accesses credential files.',
};
const ENTRY = { fingerprint: PRINT, rule: 'PE3', file: 'repo/tests/AGENTS.md', reason: 'A note for test authors, not an instruction to read it.' };

let dir = '';
const at = (/** @type {string} */ name) => join(dir, name);
/** The judge run as the workflow runs it; its exit code and output. */
const judge = (/** @type {string[]} */ args, script = JUDGE) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-findings-'));
  await writeFile(at('base.json'), JSON.stringify({ issues: [] }));
  await writeFile(at('head.json'), JSON.stringify({ issues: [HIGH] }));
  await writeFile(at('accepted.json'), JSON.stringify([ENTRY]));
  await writeFile(at('stale.json'), JSON.stringify([{ ...ENTRY, fingerprint: 'f'.repeat(64) }]));
  await symlink(JUDGE, at('linked.mjs'));
});
after(() => rm(dir, { recursive: true, force: true }));

test('a new high finding fails the scan, and its annotation names it', () => {
  const findings = judge(['findings', at('base.json'), at('head.json')]);
  assert.equal(findings.code, 1);
  assert.match(findings.out, /\| HIGH \|/);
  const notes = judge(['annotations', at('base.json'), at('head.json')]);
  assert.equal(notes.code, 0, 'the workflow ignores the annotations’ exit code; the findings step fails it');
  assert.match(notes.out, /^::error /m);
});

test('an accepted finding passes, and an accepted one that matches nothing fails', () => {
  assert.equal(judge(['findings', at('base.json'), at('head.json'), at('accepted.json')]).code, 0);
  assert.equal(judge(['findings', at('base.json'), at('base.json'), at('stale.json')]).code, 1);
});

test('run through a symlink, the judge still judges', () => {
  assert.equal(judge(['findings', at('base.json'), at('head.json')], at('linked.mjs')).code, 1);
});

test('with no arguments it exits 2, which the workflow reads as a judge it can run', () => {
  assert.equal(judge([]).code, 2);
});
