import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMENT_MARK, diffUrl, findingsReport, globsOf, newFindings, notices, reviewComment, spoofs, touched, triggersOf } from '../tools/prompt-gate.mjs';

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

const GATE = '.github/workflows/prompt-surface-gate.yml';
const CHECK = 'Prompt surface reviewed';

test('the gate’s own workflow names its check only while it runs on pull_request_target alone', () => {
  const real = readFileSync(join(ROOT, GATE), 'utf8');
  assert.ok(real.includes(`name: ${CHECK}`), 'The gate’s job is named as the ruleset requires');
  assert.deepEqual(triggersOf(real), ['pull_request_target']);
  assert.deepEqual(spoofs(CHECK, GATE, [{ path: GATE, text: real }]), []);
  const widened = real.replace('on:\n  pull_request_target:', 'on:\n  pull_request:\n  pull_request_target:');
  assert.deepEqual(spoofs(CHECK, GATE, [{ path: GATE, text: widened }]), [GATE]);
});

test('another workflow that names a job like the gate’s check is refused', () => {
  const twin = `name: x\non: [pull_request]\njobs:\n  y:\n    name: ${CHECK}\n    runs-on: ubuntu-latest\n`;
  assert.deepEqual(spoofs(CHECK, GATE, [{ path: '.github/workflows/x.yml', text: twin }]), ['.github/workflows/x.yml']);
  assert.deepEqual(spoofs(CHECK, GATE, [{ path: '.github/workflows/x.yml', text: twin.replace(CHECK, 'Lint') }]), []);
});

test('the triggers read from inline and block forms', () => {
  assert.deepEqual(triggersOf('on: push\n'), ['push']);
  assert.deepEqual(triggersOf("'on': [push, pull_request]\n"), ['push', 'pull_request']);
  assert.deepEqual(triggersOf('on:\n  pull_request:\n    types: [opened]\n  push:\n    branches: [main]\njobs:\n'), ['pull_request', 'push']);
});

const WHERE = { repo: 'HJeon139/postbox', pr: 379, runUrl: 'https://github.com/HJeon139/postbox/actions/runs/1' };

test('a file’s diff link is the pull request’s files page, anchored by the SHA-256 of its path, as GitHub does', () => {
  assert.equal(
    diffUrl('HJeon139/postbox', 379, 'server/personas/gpt.md'),
    'https://github.com/HJeon139/postbox/pull/379/files#diff-aabcca4d1e0e07450abf1c97dd4a380e22c50c756bc9bbb8fa4e28dfe959f393',
  );
});

test('the run page gets a notice for each file, and one for where the rendered diff is', () => {
  const lines = notices(['server/personas/gpt.md', 'server/mcp.mjs'], WHERE);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.startsWith('::notice title=Review before approving::')));
  assert.match(
    lines[0],
    /^::notice title=Review before approving::server\/personas\/gpt\.md changed: https:\/\/github\.com\/HJeon139\/postbox\/pull\/379\/files#diff-[0-9a-f]{64}$/,
  );
  assert.match(lines[2], /pull\/379\/checks$/);
});

test('a file name can’t end a notice early or start a command of its own', () => {
  const [line] = notices(['a%0A::error::x\nb\r'], WHERE);
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.includes('a%250A::error::x%0Ab%0D changed'));
});

test('the comment lists each file as code, so a name can’t be read as Markdown or mention anyone', () => {
  const body = reviewComment(['server/personas/gpt.md', '@alice', 'x`y.md', '[link](http://evil)'], WHERE);
  assert.ok(body.startsWith(COMMENT_MARK));
  assert.ok(body.includes('- [`@alice`]('));
  assert.ok(body.includes('- [``x`y.md``]('));
  assert.ok(body.includes('- [`[link](http://evil)`]('));
  assert.ok(body.includes(`[the gate’s run](${WHERE.runUrl})`));
});

test('a pull request that no longer touches the prompt surface gets its comment updated to say so', () => {
  assert.match(reviewComment([], WHERE), /no longer changes what agents read/);
});

test('a pull request over the 3,000 files GitHub lists says so, rather than list a file that isn’t one', () => {
  const body = reviewComment([], { ...WHERE, tooMany: true });
  assert.match(body, /More than the 3,000 files GitHub lists changed/);
  assert.doesNotMatch(body, /files#diff-/);
  assert.match(notices([], { ...WHERE, tooMany: true })[0], /More than the 3,000 files/);
});
