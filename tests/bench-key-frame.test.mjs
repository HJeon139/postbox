// PF-1’s key-to-frame bench (#508, tools/bench-key-frame.mjs): its options, the command its report shows, and what it
// leaves behind when a size’s Postbox doesn’t start.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandLine, options } from '../tools/bench-key-frame.mjs';

// A home folder under a prefix, as on a Cloud Desktop: replacing the home with ~ turned /local/home/user/… into /local~/….
const ROOT = '/local/home/user/postbox';

test('the report’s command shows --out relative to the repo, or as just its name outside it, never an absolute path', () => {
  const inside = commandLine(options(['--sizes', '200,800', '--out', `${ROOT}/designs/508/key-frame.md`]), ROOT);
  const outside = commandLine(options(['--out', '/local/home/user/elsewhere/report.md']), ROOT);
  assert.match(inside, / --out designs\/508\/key-frame\.md$/);
  assert.match(outside, / --out report\.md$/);
  for (const shown of [inside, outside]) assert.doesNotMatch(shown, /\/local|~/, shown);
});
