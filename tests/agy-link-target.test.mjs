// #1215: a link whose target has a .. after another link leads where the file system says, not where a lexical reading
// of the target says. JavaScript’s realpathSync reads a target’s .. lexically, so agy’s hook judged a write that lands
// outside the folder as inside it. On a real file system, as the kernel resolves it.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { realTarget } from '../server/adapters/agy-paths.mjs';
import { kiroRules } from '../server/adapters/kiro-cli-agent.mjs';
import { appPath } from '../server/adapters/mock-showcase.mjs';
import { inProject } from '../server/request-words.mjs';
import { tempDir } from './temp-dirs.mjs';

/** ws/x links to sub/../f, and ws/sub links to outside/sub, so x leads to outside/f; a ws/f is there too, the lexical answer. */
function aLinkThroughALink() {
  const home = realpathSync(tempDir('pb-agy-link-target-'));
  const ws = join(home, 'ws');
  const out = join(home, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(out, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'f'), 'inside');
  writeFileSync(join(out, 'f'), 'outside');
  symlinkSync(join(out, 'sub'), join(ws, 'sub'));
  symlinkSync('sub/../f', join(ws, 'x'));
  return { home, ws, out };
}

test('#1215 a link whose target has a .. after another link leads where the file system opens it', () => {
  const { ws, out } = aLinkThroughALink();
  assert.equal(readFileSync(join(ws, 'x'), 'utf8'), 'outside', 'the kernel opens outside/f through ws/x');
  assert.equal(realTarget(join(ws, 'x'), ws), join(out, 'f'));
  assert.equal(realTarget('x', ws), join(out, 'f'), 'named relative to the workspace too');
});

test('#1215 a write or read through that link is judged as outside the folder, and one to the real ws/f is still inside', () => {
  const { home, ws } = aLinkThroughALink();
  const opts = { mode: 'auto', folders: [ws], cwd: ws, home };
  const decide = (name, args) => decideAgyTool({ toolCall: { name, args } }, opts).decision;
  assert.equal(decide('read_file', { Path: join(ws, 'x') }), 'ask', 'a read through x reads outside/f');
  assert.notEqual(decide('write_to_file', { TargetFile: join(ws, 'x') }), 'allow', 'a write through x writes outside/f');
  assert.equal(decide('read_file', { Path: join(ws, 'f') }), 'allow', 'the workspace’s own f is still read with no card');
  assert.equal(decide('write_to_file', { TargetFile: join(ws, 'f') }), 'allow', 'and written with no card, in Auto');
});

test('#1215 the other judges of a path agree: a command’s path through that link isn’t the project’s, nor a write’s', () => {
  const { ws } = aLinkThroughALink();
  assert.equal(inProject('x', ws), false, 'request-words: x leads outside the project');
  assert.equal(inProject('f', ws), true, 'and the project’s own f is still in it');
  assert.equal(appPath(ws, 'x'), null, 'mock-showcase: a write through x would land outside the room’s folder');
  assert.equal(appPath(ws, 'f'), join(ws, 'f'), 'and one to its own f still goes there');
});

test('#1215 Kiro’s rules for a folder that is such a link allow where it leads, not its lexical sibling', () => {
  const { ws, out } = aLinkThroughALink();
  // A folder the permission panel keeps as the person spelled it: ws/dl links to sub/../d, which leads to outside/d.
  // Read lexically it’s ws/d, a different folder, there too.
  mkdirSync(join(out, 'd'));
  mkdirSync(join(ws, 'd'));
  symlinkSync('sub/../d', join(ws, 'dl'));
  const rules = kiroRules({ persona: { permissionMode: 'auto', tools: [] }, folders: [join(ws, 'dl')] });
  const allowed = (/** @type {string} */ cap) => rules.filter((r) => r.capability === cap && r.effect === 'allow').flatMap((r) => r.match);
  for (const cap of ['fs_read', 'fs_write']) {
    assert.ok(allowed(cap).includes(join(out, 'd')), `${cap} allows where the folder leads: ${allowed(cap).join(', ')}`);
    assert.ok(!allowed(cap).includes(join(ws, 'd')), `${cap} doesn’t allow the lexical sibling ws/d`);
  }
});
