// Server source as the guards read it: each file's text with the lines the formatter split joined, and each site that
// matches a pattern placed by file and the function it's in (#601, tests/store-held-guard.test.mjs).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DECL =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b)(\w+)\s*\([^)]*\)\s*\{\s*$|^(?:export\s+)?const\s+(\w+)\s*=/;
/** The function a line is in: the nearest declaration above it. @param {string[]} lines @param {number} i */
function enclosing(lines, i) {
  for (let j = i; j >= 0; j--) {
    const m = lines[j].match(DECL);
    if (m) return m[1] ?? m[2] ?? m[3];
  }
  return '(top)';
}
/** Optional chaining read as a plain member, so `rt.store?.items(` is placed as `rt.store.items(` is. @param {string} t */
export const normalized = (t) => t.replace(/\?\.(?=[A-Za-z_$])/g, '.');
/** Each server file's source, with the lines the formatter split joined. @returns {[string, string][]} */
export function sources(dir = new URL('../server', import.meta.url).pathname, rel = '', out = /** @type {[string, string][]} */ ([])) {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (path !== 'remote/host') sources(dir, path, out);
      continue;
    }
    if (!/\.(mjs|js|cjs)$/.test(e.name) || ['store.mjs', 'store-held.mjs'].includes(path)) continue;
    const text = normalized(readFileSync(join(dir, path), 'utf8'))
      .replace(/\s*\n\s*(?=\.[A-Za-z_(])/g, '')
      .replace(/\(\s*\n\s*/g, '(')
      .replace(/\s*\n\s*(?=\()/g, '');
    out.push([path, text]);
  }
  return out;
}
/** file → the enclosing function of each line matching `re`, in order. @param {RegExp} re */
function sites(re) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [path, text] of sources()) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (re.test(line) && !/^\s*(\/\/|\*)/.test(line)) (out[path] ??= []).push(enclosing(lines, i));
    });
  }
  return out;
}
export const placed = (re, table, what) =>
  assert.deepEqual(
    sites(re),
    table,
    `${what} changed: place each site, with its reason, by the rule at the top of this file. Found: ${JSON.stringify(sites(re))}`,
  );
