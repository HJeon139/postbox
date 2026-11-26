// #136, recorded on kiro-cli 3.1.0, v3, with the agent file kiroRules writes (in a Kiro home and a folder of their
// own, Isolated): in Auto with Shell a command runs; on the rules from before #136 the same turn has it refused, as
// Ask me does; without Shell Kiro offers no shell tool; and without Shell an edit of .kiro/settings/mcp.json is
// refused while an ordinary file in the folder is written. Each stream replays through the real mapper.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fixture } from './kiro-cli-fakes.mjs';

/** The steps a recorded turn shows, as [label, state]. @param {string} name */
function steps(name) {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000, effort: 'low' });
  for (const e of fixture(name)) m.push(e);
  assert.equal(m.error, null, name);
  return ctx.calls.activity.map((a) => [a.label, a.state]);
}

test('#136 recorded: in Auto with Shell, a command runs; on the rules before #136 it was refused', () => {
  assert.deepEqual(steps('auto-shell'), [
    ['Run echo probe command', 'running'],
    ['Run echo probe command', 'done'],
  ]);
  assert.deepEqual(steps('auto-shell-before'), [
    ['Run echo probe command', 'running'],
    ['Run echo probe command', 'denied'],
  ]);
});

test('#136 recorded: without Shell, Kiro offers no shell tool, so there’s no command step at all', () => {
  assert.deepEqual(steps('auto-noshell'), []);
});

test('#136 recorded: an edit of .kiro/settings/mcp.json is refused; an ordinary file in the folder is written', () => {
  assert.deepEqual(
    steps('auto-kiro-write').filter(([, state]) => state !== 'running'),
    [
      ['Wrote mcp.json', 'denied'],
      ['Wrote notes.md', 'done'],
    ],
  );
});

// #1723, recorded on kiro-cli 3.6.2 (v3, claude-haiku-4.5), with the agent file the branch's kiroAgent writes, Isolated,
// in a Kiro home and folders of their own under /tmp: in Auto with Shell, the file tools read and write outside the
// agent's folders, and an edit of the folder's .kiro/settings/mcp.json is still refused. No Postbox server ran, so its
// tools didn't load; that step is the probe's, not the rule's.
test('#1723 recorded: in Auto with Shell, files outside the folders are read and written; .kiro stays refused', () => {
  assert.deepEqual(
    steps('auto-shell-files').filter(([label, state]) => state !== 'running' && !label.startsWith('Postbox’s tools')),
    [
      ['Read readme.txt', 'done'],
      ['Wrote mcp.json', 'denied'],
      ['Wrote new.txt', 'done'],
    ],
  );
});
