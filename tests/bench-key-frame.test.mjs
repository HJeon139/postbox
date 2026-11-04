// PF-1’s key-to-frame bench (#508, tools/bench-key-frame.mjs): its options, the command its report shows, and what it
// leaves behind when a size’s Postbox doesn’t start.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandLine, measureSize, options } from '../tools/bench-key-frame.mjs';

// A home folder under a prefix, as on a Cloud Desktop: replacing the home with ~ turned /local/home/user/… into /local~/….
const ROOT = '/local/home/user/postbox';

test('the report’s command shows --out relative to the repo, or as just its name outside it, never an absolute path', () => {
  const inside = commandLine(options(['--sizes', '200,800', '--out', `${ROOT}/designs/508/key-frame.md`]), ROOT);
  const outside = commandLine(options(['--out', '/local/home/user/elsewhere/report.md']), ROOT);
  assert.match(inside, / --out designs\/508\/key-frame\.md$/);
  assert.match(outside, / --out report\.md$/);
  for (const shown of [inside, outside]) assert.doesNotMatch(shown, /\/local|~/, shown);
});

test('a size whose Postbox doesn’t start leaves no data folder behind', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    const start = async () => {
      throw new Error('Postbox didn’t start: refused');
    };
    const o = options(['--sizes', '200']);
    await assert.rejects(
      measureSize(null, 200, o, () => {}, { start, port: async () => 1, tmp }),
      /Postbox didn’t start: refused/,
    );
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
