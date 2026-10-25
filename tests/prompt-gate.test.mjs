import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The repo’s modules a file imports directly, relative to the repo. */
const importsOf = (file) =>
  [...readFileSync(join(ROOT, file), 'utf8').matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s+'(\.[^']+)'/g)].map((m) =>
    relative(ROOT, resolve(ROOT, dirname(file), m[1])),
  );
/**
 * Modules the rendered text’s sources import that aren’t prompt surface, and why. A module joins this list only with a
 * reason; one that lends the guide or a tool description any text goes in .github/prompt-surface-paths.txt instead.
 */
const NOT_SURFACE = {
  'server/helpers.mjs': 'mcp.mjs takes sameToken(), a token comparison',
  'server/runtime.mjs': 'mcp.mjs takes AgentFileError, an error class; what the runtime says to agents is out of the render (SECURITY.md, “Prompt changes”)',
  'server/store.mjs': 'seed.mjs takes newId()',
  'server/adapters/claude-stream.mjs': 'describeTool() and isQuietTool() label tool calls for the person’s transcript',
  'server/adapters/folder.mjs': 'agentFolder(), a path',
  'server/adapters/process-group.mjs': 'process control',
};

test('every module the rendered text comes from is prompt surface, or excused with a reason', () => {
  const sources = importsOf('tools/prompt-surface.mjs');
  const modules = [...new Set([...sources, ...sources.flatMap(importsOf)])].sort();
  const missed = modules.filter((m) => !touched([m], GLOBS).length && !Object.hasOwn(NOT_SURFACE, m));
  assert.deepEqual(missed, [], 'Add these to .github/prompt-surface-paths.txt, or to NOT_SURFACE with a reason');
  // An excuse for a module the sources no longer import is stale.
  assert.deepEqual(
    Object.keys(NOT_SURFACE).filter((m) => !modules.includes(m)),
    [],
  );
});

test('the import reader follows an import that spans lines', () => {
  assert.ok(importsOf('server/mcp.mjs').includes('server/permission-prompt.mjs'));
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
