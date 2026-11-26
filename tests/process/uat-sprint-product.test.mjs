// The idleroom scenarios’ product (tests/uat/e2e/fixtures/sprint: Titles, #1784): its acceptance suite fails until the
// six parts are built, and a build of them turns it green, so the stories are real work with a real end, and the parts
// that build on another do. The build here is the test’s own, written into a throwaway copy: an agent’s workspace never
// has it. It runs node’s test runner, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../uat/e2e/fixtures/sprint', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pb-test-titles-'));
after(() => rmSync(dir, { recursive: true, force: true }));
cpSync(FIXTURE, dir, { recursive: true });
// Node’s test runner as a shell has it: this file’s own runner isn’t the suite’s.
const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;

/** The suite’s counts, from its own summary. */
function suite() {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  const count = (/** @type {string} */ what) => Number(new RegExp(`^# ${what} (\\d+)$`, 'm').exec(r.stdout)?.[1]);
  return { pass: count('pass'), fail: count('fail') };
}

const BUILD = {
  'src/words.mjs': "export const words = (title) => title.match(/[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*/gu) ?? [];\n",
  'src/slug.mjs':
    "import { words } from './words.mjs';\nexport const slug = (title) =>\n  words(title)\n    .map((w) => w.toLowerCase().replace(/['’]/g, ''))\n    .join('-') || 'untitled';\n",
  'src/title-case.mjs':
    "import { words } from './words.mjs';\nconst SMALL = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'or']);\nconst cased = (w, edge) => {\n  if (w.length > 1 && w === w.toUpperCase()) return w;\n  if (!edge && SMALL.has(w.toLowerCase())) return w.toLowerCase();\n  return w[0].toUpperCase() + w.slice(1).toLowerCase();\n};\nexport const titleCase = (title) =>\n  words(title)\n    .map((w, i, all) => cased(w, i === 0 || i === all.length - 1))\n    .join(' ');\n",
  'src/truncate.mjs':
    "export function truncate(title, max) {\n  if (title.length <= max) return title;\n  const cut = title.slice(0, max - 1);\n  const at = cut.lastIndexOf(' ');\n  const whole = title[max - 1] !== ' ' && at > 0 ? cut.slice(0, at) : cut;\n  return whole.trimEnd() + '…';\n}\n",
  'src/filename.mjs':
    "import { slug } from './slug.mjs';\nexport function filename(title, ext) {\n  const whole = slug(title);\n  const cut = whole.length > 40 ? whole.slice(0, whole.slice(0, 41).lastIndexOf('-')) : whole;\n  return cut + '.' + ext;\n}\n",
  'cli.mjs':
    "import { filename } from './src/filename.mjs';\nimport { slug } from './src/slug.mjs';\nimport { titleCase } from './src/title-case.mjs';\nconst [form, title, ext] = process.argv.slice(2);\nconst forms = { slug: () => slug(title), title: () => titleCase(title), filename: () => filename(title, ext) };\nif (!forms[form]) {\n  console.error('Usage: node cli.mjs slug|title|filename \"<title>\" [ext]');\n  process.exit(1);\n}\nconsole.log(forms[form]());\n",
};

test('the acceptance suite fails with nothing built, part by part, and passes its 19 tests once the six parts are', () => {
  // Unbuilt, a file whose module is missing fails as one test, and the command’s three fail one by one.
  assert.deepEqual(suite(), { pass: 0, fail: 8 });
  mkdirSync(join(dir, 'src'));
  // Words alone turns its own three green and nothing that builds on it.
  writeFileSync(join(dir, 'src/words.mjs'), BUILD['src/words.mjs']);
  assert.deepEqual(suite(), { pass: 3, fail: 7 });
  for (const [file, text] of Object.entries(BUILD)) writeFileSync(join(dir, file), text);
  assert.deepEqual(suite(), { pass: 19, fail: 0 });
});
