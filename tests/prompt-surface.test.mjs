import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BOILERPLATES } from '../server/seed.mjs';
import { render } from '../tools/prompt-surface.mjs';

/** Every file under a folder, relative to it, with its text. */
function filesOf(dir, at = '') {
  return readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesOf(dir, join(at, e.name)) : [[join(at, e.name), readFileSync(join(dir, at, e.name), 'utf8')]],
  );
}

test('the prompt surface renders the same files twice, so a diff of two renders is only what changed', () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), 'pb-surface-')), mkdtempSync(join(tmpdir(), 'pb-surface-'))];
  try {
    render(a);
    render(b);
    assert.deepEqual(filesOf(a), filesOf(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('it renders what agents read: the guide, the tools, each boilerplate’s instructions, and the repo’s AGENTS.md', () => {
  const out = mkdtempSync(join(tmpdir(), 'pb-surface-'));
  try {
    render(out);
    const files = new Map(filesOf(out));
    assert.match(files.get('scan/guide.md') ?? '', /^You are @agent, an agent in Postbox/);
    assert.match(files.get('scan/queued-messages.md') ?? '', /2 messages arrived[\s\S]*@reviewer[\s\S]*the person/);
    assert.match(files.get('scan/mcp-tools.md') ?? '', /## show_block\n\nShow a catalog block/);
    for (const b of BOILERPLATES) {
      const handle = b.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (b.instructions) assert.ok(files.get(`scan/personas/boilerplate-${handle}.md`)?.includes(b.instructions.trim()), b.name);
      assert.ok(files.has(`agents/boilerplate-${handle}.md`), b.name);
    }
    assert.ok(files.has('scan/repo/AGENTS.md'));
    // The limits the guide interpolates are filled in, not left as code.
    assert.doesNotMatch(files.get('scan/mcp-tools.md') ?? '', /\$\{/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('it refuses a folder that isn’t empty, rather than mix two renders', () => {
  const out = mkdtempSync(join(tmpdir(), 'pb-surface-'));
  try {
    render(out);
    assert.throws(() => render(out), /isn’t empty/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
