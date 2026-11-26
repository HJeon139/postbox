// Step 2 of tools/signoff.mjs fails closed (#845): every node-version a workflow gives names a Node major this script
// reads, or the step fails naming the workflow and the value, and a `${{ matrix.<key> }}` is read from that job’s own
// strategy.matrix, never from a line elsewhere in the file.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultDeps } from '../tools/signoff/deps.mjs';
import { ciMajors, majorsIn } from '../tools/signoff/workflows.mjs';
import { EXIT, signoff } from '../tools/signoff.mjs';
import { gateLog, putLog, world } from './signoff-fake.mjs';

/** A job of a workflow, indented under jobs:, its lines given at the job’s own indent. @param {string} name @param {string[]} lines */
const job = (name, lines) => [`  ${name}:`, ...lines.map((l) => `    ${l}`)].join('\n');
/** A workflow of the given jobs. @param {...string} jobs */
const workflow = (...jobs) => `name: CI\non: push\njobs:\n${jobs.join('\n')}\n`;
const setup = (version) => ['steps:', '  - uses: actions/setup-node@v4', '    with:', `      node-version: ${version}`];

test('a node-version list with any item that isn’t a major throws, naming that item', () => {
  assert.throws(
    () => majorsIn(workflow(job('t', setup('[22, lts/*]')))),
    /node-version: \[22, lts\/\*\] names lts\/\*, which isn’t a Node major this script can read/,
  );
  assert.throws(() => majorsIn(workflow(job('t', setup('lts/*')))), /node-version: lts\/\* names lts\/\*, which isn’t/);
});

test('a matrix key with any value that isn’t a major throws, naming the value and the key', () => {
  const t = job('t', ['strategy:', '  matrix:', '    node: [22, current]', ...setup(`\${{ matrix.node }}`)]);
  assert.throws(() => majorsIn(workflow(t)), /node-version: \$\{\{ matrix\.node \}\} names current \(matrix\.node\), which isn’t a Node major/);
});

test('a node-version-file throws: this script doesn’t read the file it names', () => {
  const t = job('t', ['steps:', '  - uses: actions/setup-node@v4', '    with:', '      node-version-file: .nvmrc']);
  assert.throws(() => majorsIn(workflow(t)), /node-version-file: \.nvmrc isn’t read by this script: name the major in node-version/);
});

test('a matrix key is read from its own job’s strategy.matrix, never from a line elsewhere in the file', () => {
  const other = job('other', ['env:', '  node: 18', ...setup('24')]);
  const t = job('t', ['strategy:', '  matrix:', `    node: \${{ fromJSON(inputs.nodes) }}`, ...setup(`\${{ matrix.node }}`)]);
  assert.throws(() => majorsIn(workflow(other, t)), /names \$\{\{ fromJSON\(inputs\.nodes\) \}\} \(matrix\.node\), which isn’t/);
  const unused = job('a', ['strategy:', '  matrix:', '    node: [20]', ...setup('24')]);
  const used = job('b', ['strategy:', '  matrix:', '    node: [22]', '    os: [ubuntu]', ...setup(`\${{ matrix.node }}`)]);
  assert.deepEqual(majorsIn(workflow(unused, used)), [24, 22]);
});

test('a matrix key whose job has no strategy.matrix block throws, rather than borrowing another job’s', () => {
  const a = job('a', ['strategy:', '  matrix:', '    node: [20]', ...setup('20')]);
  const b = job('b', setup(`\${{ matrix.node }}`));
  assert.throws(
    () => majorsIn(workflow(a, b)),
    /node-version: \$\{\{ matrix\.node \}\} names no Node major: job b has no strategy\.matrix block this script reads/,
  );
  const inline = job('c', ['strategy:', `  matrix: \${{ fromJSON(inputs.m) }}`, ...setup(`\${{ matrix.node }}`)]);
  assert.throws(() => majorsIn(workflow(inline)), /job c has no strategy\.matrix block this script reads/);
});

test('matrix.include entries in the job’s own matrix name their majors, and a key deeper in an entry doesn’t', () => {
  const t = job('t', [
    'strategy:',
    '  matrix:',
    '    include:',
    '      - node: 22',
    '        os: ubuntu',
    '        extra:',
    '          node: 18',
    '      - os: macos',
    "        node: '24.x'",
    ...setup(`\${{ matrix.node }}`),
  ]);
  assert.deepEqual(majorsIn(workflow(t)), [22, 24]);
});

test('a workflow with a node-version this can’t read fails step 2, naming the workflow and the value', async () => {
  const w = world();
  putLog(w, gateLog(w.head));
  w.files.set('/repo/.github/workflows/nightly.yml', workflow(job('t', setup('[22, lts/*]'))));
  assert.equal(await signoff(['840'], w.d), EXIT.toolchain);
  assert.match(w.lines.find((l) => l.startsWith('✖ 2.')) ?? '', /\.github\/workflows\/nightly\.yml: node-version: \[22, lts\/\*\] names lts\/\*/);
});

test('the repo’s own workflows run Node 22, and every node-version in them is read', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(
    ciMajors(defaultDeps(), root).map((m) => m.major),
    [22],
  );
});
