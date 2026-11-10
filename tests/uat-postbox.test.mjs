// The run’s own Postbox (#782; tools/uat/postbox.mjs): the benches and a run’s recheck start it or read its port
// without a browser, so nothing it imports may load Playwright, which a machine without it can’t import.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** Every module specifier a file imports or re-exports statically. @param {string} text */
const specifiersOf = (text) => [...text.matchAll(/^\s*(?:import|export)\b[^'"`;]*?(?:from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);

/** The bare specifiers reached from a module through its static relative imports, by the path that reached each. @param {URL} start */
function bareImportsFrom(start) {
  const seen = new Set();
  /** @type {Map<string, string[]>} */
  const bare = new Map();
  const walk = (/** @type {URL} */ url, /** @type {string[]} */ path) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    for (const spec of specifiersOf(readFileSync(url, 'utf8'))) {
      if (spec.startsWith('.')) walk(new URL(spec, url), [...path, spec]);
      else if (!bare.has(spec)) bare.set(spec, path);
    }
  };
  walk(start, ['tools/uat/postbox.mjs']);
  return { seen, bare };
}

test('#782 nothing tools/uat/postbox.mjs imports, however deep, loads @playwright/test', () => {
  const { seen, bare } = bareImportsFrom(new URL('../tools/uat/postbox.mjs', import.meta.url));
  assert.ok(seen.size > 1, 'the walk followed its relative imports');
  assert.ok(bare.has('node:child_process'), 'the walk read its imports');
  assert.equal(bare.get('@playwright/test'), undefined, 'Playwright reached through this path of imports');
});
