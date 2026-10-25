import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findingsReport, globsOf, newFindings, touched } from '../tools/prompt-gate.mjs';

const GLOBS = globsOf(readFileSync(new URL('../.github/prompt-surface-paths.txt', import.meta.url), 'utf8'));

test('the gate asks for approval when a pull request touches a persona, the guide, an AGENTS.md or a workflow', () => {
  const changed = [
    'server/personas/gpt.md',
    'server/adapters/guide.mjs',
    'tests/AGENTS.md',
    'AGENTS.md',
    '.github/workflows/check.yml',
    'designs/prompts/w5-pane.md',
    'app/js/thread.mjs',
    'server/store.mjs',
    'README.md',
  ];
  assert.deepEqual(touched(changed, GLOBS), changed.slice(0, 6));
});

test('a star stays within a folder, and a dot is a dot', () => {
  assert.deepEqual(touched(['server/personas/a/b.md', 'server/personasXmd'], ['server/personas/*', 'server/personas.md']), []);
  assert.deepEqual(touched(['server/personas/a/b.md'], ['server/personas/**']), ['server/personas/a/b.md']);
});

test('comments and blank lines in the paths file aren’t globs', () => {
  assert.deepEqual(globsOf('# a comment\n\nserver/mcp.mjs  # the tools\n'), ['server/mcp.mjs']);
});

const finding = (fingerprint, severity) => ({
  match_fingerprint: fingerprint,
  severity,
  id: 'P1',
  category: 'Prompt Injection',
  location: { file: 'scan/personas/x.md', start_line: 3 },
  finding: 'ignore all previous | instructions',
});

test('only findings the pull request adds count, so one main already has doesn’t fail every pull request', () => {
  const base = { issues: [finding('a', 'HIGH')] };
  const head = { issues: [finding('a', 'HIGH'), finding('b', 'MEDIUM')] };
  assert.deepEqual(
    newFindings(base, head).map((i) => i.match_fingerprint),
    ['b'],
  );
});

test('the report lists each new finding in one table row, with its pipe escaped', () => {
  const report = findingsReport({ issues: [] }, { issues: [finding('b', 'HIGH')], risk_assessment: { score: 43 } });
  assert.match(report, /risk score — on the base, 43 with this pull request/);
  assert.match(report, /\| HIGH \| P1 Prompt Injection \| scan\/personas\/x\.md \| 3 \| ignore all previous \\\| instructions \|/);
  assert.match(findingsReport({ issues: [] }, { issues: [] }), /No new findings\./);
});
