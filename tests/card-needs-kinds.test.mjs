// Every kind an agent's need can have is ranked (#366; the integrator's re-review of #633: a table that ranks a kind it
// doesn't list fell to a default, so a failed turn's need lost to any card). This finds each kind set in server/: a
// direct `needs: { kind }`, an offerNeed, and each need card-needs.mjs's needOf makes.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RANK } from '../server/card-needs.mjs';

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.mjs') ? [join(dir, f)] : []));

test('every need kind set anywhere in server/ is in RANK', () => {
  const kinds = new Set();
  for (const f of files('server')) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/needs: \{ kind: '([a-z]+)'|offerNeed\([^)]*?\{ kind: '([a-z]+)'/g)) kinds.add(m[1] ?? m[2]);
    if (f.endsWith('card-needs.mjs')) for (const m of text.matchAll(/return \{ kind: '([a-z]+)'/g)) kinds.add(m[1]);
  }
  assert.ok(kinds.has('failed') && kinds.has('appsend') && kinds.has('block'), `the scan found the kinds: ${[...kinds]}`);
  assert.deepEqual(
    [...kinds].filter((k) => !(k in RANK)),
    [],
    'each one ranked',
  );
});
