import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACCEPTED_FILE, acceptedProblems, annotations, findingsReport, judge } from '../tools/prompt-findings.mjs';

// A finding as SkillSpector reports one: the #387 case, a test note that names ~/.npmrc.
const PRINT = '58ad794262acddeb5ede92f20cb4814e3ac43a46c218604ec928af500aa80424';
const finding = (print = PRINT, severity = 'HIGH') => ({
  match_fingerprint: print,
  severity,
  id: 'PE3',
  category: 'Privilege Escalation',
  location: { file: 'repo/tests/AGENTS.md', start_line: 16 },
  finding: '~/.npmrc',
  explanation: 'Code accesses credential files.',
});
const BASE = { issues: [] };
const HEAD = { issues: [finding()] };
const ENTRY = { fingerprint: PRINT, rule: 'PE3', file: 'repo/tests/AGENTS.md', reason: 'A note for test authors, not an instruction to read it.' };

test('the accepted findings list in the repository is well formed', () => {
  assert.deepEqual(acceptedProblems(JSON.parse(readFileSync(new URL(`../${ACCEPTED_FILE}`, import.meta.url), 'utf8'))), []);
});

test('an entry needs a fingerprint, the rule, the file and a reason, and no fingerprint twice', () => {
  assert.deepEqual(acceptedProblems([ENTRY]), []);
  assert.equal(acceptedProblems({}).length, 1);
  assert.match(acceptedProblems([{ ...ENTRY, reason: 'fine' }]).join(), /needs a reason/);
  assert.match(acceptedProblems([{ ...ENTRY, fingerprint: 'x' }]).join(), /64 hex digits/);
  assert.match(acceptedProblems([ENTRY, ENTRY]).join(), /repeats a fingerprint/);
});

test('a new high finding blocks unless the list accepts it, and a medium one is advice', () => {
  assert.equal(judge(BASE, HEAD).blocking.length, 1);
  assert.equal(judge(BASE, HEAD, [ENTRY]).blocking.length, 0);
  assert.equal(judge(BASE, { issues: [finding('a'.repeat(64), 'MEDIUM')] }).blocking.length, 0);
  // One main already has doesn’t count against the pull request.
  assert.equal(judge(HEAD, HEAD).blocking.length, 0);
});

test('an accepted entry that matches nothing any more is stale', () => {
  assert.deepEqual(judge(BASE, BASE, [ENTRY]).stale, [ENTRY]);
  assert.deepEqual(judge(BASE, HEAD, [ENTRY]).stale, []);
});

test('the summary shows the blocking finding and the line that would accept it', () => {
  const report = findingsReport(BASE, HEAD);
  assert.match(report, /\| HIGH \| PE3 Privilege Escalation \| repo\/tests\/AGENTS\.md \| 16 \| ~\/\.npmrc \| \*\*blocks\*\* \|/);
  assert.ok(report.includes(`{"fingerprint":"${PRINT}","rule":"PE3","file":"repo/tests/AGENTS.md","reason":"Say why this isn’t a threat."}`));
  const ok = findingsReport(BASE, HEAD, [ENTRY]);
  assert.match(ok, /accepted: A note for test authors/);
  assert.doesNotMatch(ok, /If a finding isn’t a threat/);
});

test('the run page gets an error on the repository file and line, readable without the summary', () => {
  const [line] = annotations(BASE, HEAD);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /^::error file=tests\/AGENTS\.md,line=16,title=SkillSpector PE3 \(HIGH\)::Privilege Escalation in repo\/tests\/AGENTS\.md: ~\/\.npmrc\./);
  // A rendered file, not one in the repository, carries no file property.
  const guide = { issues: [{ ...finding(), location: { file: 'guide.md', start_line: 3 } }] };
  assert.match(annotations(BASE, guide)[0], /^::error title=/);
  assert.deepEqual(annotations(BASE, HEAD, [ENTRY]), []);
  assert.match(annotations(BASE, BASE, [ENTRY])[0], /^::warning title=Stale accepted finding::/);
});

test('a matched text can’t end an annotation early or start a command', () => {
  const evil = { issues: [{ ...finding(), finding: 'x%0A\n::error::y', location: { file: 'repo/a,b:c.md', start_line: 1 } }] };
  const [line] = annotations(BASE, evil);
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.startsWith('::error file=a%2Cb%3Ac.md,line=1,'));
  assert.ok(line.includes('x%250A%0A::error::y'));
});
