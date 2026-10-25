// The agents’ steering (#315): AGENTS.md at the root and in each folder with rules of its own, read as they are by
// Claude Code, Codex, Kiro and Antigravity. These keep the files where every one of those tools reads them, within
// what each reads, and tied to the design sections they come from.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.claude', 'uat-runs', 'data', 'test-results', 'check-logs', 'screenshots']);

/** Every AGENTS.md in the repo, as a path from its root. */
function steeringFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...steeringFiles(path));
    else if (name === 'AGENTS.md') out.push(relative(ROOT, path));
  }
  return out.sort();
}
const files = steeringFiles();
const text = (f) => readFileSync(join(ROOT, f), 'utf8');

test('there is a root AGENTS.md, and it lists every folder’s, since Codex reads only the root’s', () => {
  assert.ok(files.includes('AGENTS.md'), 'a root AGENTS.md');
  const nested = files.filter((f) => f !== 'AGENTS.md');
  assert.ok(nested.length >= 5, `folder files: ${nested.join(', ')}`);
  for (const f of nested) assert.ok(text('AGENTS.md').includes(`\`${f}\``), `the root lists ${f}`);
});

test('each file fits what every tool reads: Codex joins them up to 32 KiB, Antigravity truncates one past 24 KB', () => {
  const size = (f) => Buffer.byteLength(text(f));
  assert.ok(size('AGENTS.md') <= 12_000, `the root is ${size('AGENTS.md')} bytes`);
  for (const f of files.filter((x) => x !== 'AGENTS.md')) {
    assert.ok(size(f) <= 8_000, `${f} is ${size(f)} bytes`);
    assert.ok(size('AGENTS.md') + size(f) <= 24_000, `the root and ${f} together are ${size('AGENTS.md') + size(f)} bytes`);
  }
});

test('they’re plain Markdown any tool reads: no front matter and no @ imports, which only one tool understands', () => {
  for (const f of files) {
    assert.ok(!text(f).startsWith('---'), `${f} has front matter`);
    assert.doesNotMatch(text(f), /^@\S/m, `${f} has an @ import`);
  }
});

test('no CLAUDE.md beside them: Claude Code reads AGENTS.md only where there is none', () => {
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', ...files.map((x) => join(x, '..', 'CLAUDE.md'))])
    assert.ok(!existsSync(join(ROOT, f)), `${f} would switch AGENTS.md off for Claude Code`);
});

/** A heading’s words, without the number architecture.md gives its sections. */
const headings = (file) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^#{1,4} (?:\d+\. )?(.+)$/gm)].map((m) => m[1].trim());

test('every design section a rule cites exists, by its title', () => {
  let cited = 0;
  for (const f of files) {
    for (const m of text(f).matchAll(/(designs\/[\w/.-]+\.md),((?:\s*(?:and\s+)?“[^”]+”,?)+)/g)) {
      const doc = m[1];
      assert.ok(existsSync(join(ROOT, doc)), `${f} cites ${doc}, which isn’t there`);
      for (const [, title] of m[2].matchAll(/“([^”]+)”/g)) {
        cited++;
        // The title, or the title and what follows its colon (“The store: an event log…”), not any heading it begins.
        assert.ok(
          headings(doc).some((h) => h === title || h.startsWith(`${title}:`)),
          `${f} cites ${doc}, “${title}”, and it has no section by that title`,
        );
      }
    }
  }
  assert.ok(cited >= 20, `only ${cited} citations were found: the pattern may have stopped matching`);
});
