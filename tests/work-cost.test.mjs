import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnLine } from '../shared/work.mjs';
import { turnRows } from '../shared/work-list.mjs';

/**
 * A conversation’s ledger in the shape server/ledger.mjs writes it: turns, each with a file change, commands and a read.
 * @param {number} turns @param {number} commandsPerTurn
 */
function ledger(turns, commandsPerTurn) {
  const entries = [];
  const files = Array.from({ length: 20 }, (_, i) => ({ kind: 'file', id: `wf_${i}`, path: `/p/f${i}.js`, rel: `f${i}.js`, added: 1, deleted: 0 }));
  entries.push(...files);
  for (let t = 0; t < turns; t++) {
    const turnId = `tu_${t}`;
    entries.push({ kind: 'turn', id: turnId, turnId, handle: 'researcher', ms: 1000, toolCalls: commandsPerTurn });
    entries.push({ kind: 'change', id: `wd_${t}`, turnId, handle: 'researcher', fileId: files[t % files.length].id, added: 2, deleted: 1 });
    for (let c = 0; c < commandsPerTurn; c++)
      entries.push({ kind: 'command', id: `wc_${t}_${c}`, turnId, handle: 'researcher', command: `npm test -- ${c}`, state: 'done' });
    entries.push({ kind: 'read', id: `wg_${t}`, turnId, handle: 'researcher', tool: 'Read', what: 'README.md' });
  }
  return entries;
}

/** The array, and how many of its entries were read through it. */
function counted(entries) {
  const reads = { n: 0 };
  const proxy = new Proxy(entries, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.n++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { proxy, reads };
}

// The pane draws every turn’s line and the transcript draws every turn’s list: in a conversation of 1,500 turns and
// 12,000 entries, each read the whole ledger about ten times, and opening it took seconds (#618).
test('every turn’s line and list together read the ledger a few times over, not once per turn (#618)', () => {
  const entries = ledger(200, 8);
  const { proxy, reads } = counted(entries);
  for (let t = 0; t < 200; t++) {
    turnLine(proxy, `tu_${t}`);
    turnRows(proxy, `tu_${t}`);
  }
  assert.ok(reads.n < 3 * entries.length, `read ${reads.n} entries for a ledger of ${entries.length}`);
});

test('a turn’s line counts a command pushed to the ledger after it was first drawn (#618)', () => {
  const entries = ledger(3, 1);
  assert.match(turnLine(entries, 'tu_1') ?? '', /1 command\b/);
  entries.push({ kind: 'command', id: 'wc_late', turnId: 'tu_1', handle: 'researcher', command: 'npm run build', state: 'running' });
  assert.match(turnLine(entries, 'tu_1') ?? '', /2 commands/);
  assert.equal(turnRows(entries, 'tu_1').filter((r) => r.kind === 'command').length, 2);
});

test('a turn’s line follows a command patched in place after it was first drawn (#618)', () => {
  const entries = ledger(3, 2);
  assert.doesNotMatch(turnLine(entries, 'tu_2') ?? '', /failed/);
  Object.assign(/** @type {any} */ (entries.find((e) => e.id === 'wc_2_0')), { state: 'failed', exit: 1 });
  assert.match(turnLine(entries, 'tu_2') ?? '', /2 commands \(1 failed\)/);
});
