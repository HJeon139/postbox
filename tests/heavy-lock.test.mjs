import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { acquire } from '../tools/heavy-lock.mjs';

const root = mkdtempSync(join(tmpdir(), 'pb-heavy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A slot folder of its own, the pids in `live` alive and every other gone, and a log. @param {number[]} live */
function machine(live) {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  /** @type {string[]} */
  const log = [];
  return { dir, log, alive: (/** @type {number} */ pid) => live.includes(pid), log1: (/** @type {string} */ m) => log.push(m) };
}

test('two heavy suites get a slot each at once, and a third waits until one of them lets go', async () => {
  const m = machine([1, 2, 3]);
  const o = { dir: m.dir, slots: 2, alive: m.alive, log: m.log1 };
  const first = await acquire({ ...o, pid: 1, label: 'playwright' });
  await acquire({ ...o, pid: 2, label: 'test:process' });
  let polls = 0;
  const third = await acquire({
    ...o,
    pid: 3,
    label: 'test:integration',
    sleep: async () => {
      if (++polls === 3) first();
    },
  });
  assert.equal(polls, 3, 'it waited until the first suite let go');
  assert.deepEqual(m.log, ['Waiting for a heavy-suite slot (2 of 2 in use: pid 1, playwright; pid 2, test:process).']);
  assert.equal(readdirSync(m.dir).length, 2);
  third();
  assert.equal(readdirSync(m.dir).length, 1);
});

test('a slot whose holder has exited is taken over, not waited on', async () => {
  const m = machine([7]);
  const o = { dir: m.dir, slots: 1, alive: m.alive, log: m.log1 };
  writeFileSync(join(m.dir, 'slot-0.json'), JSON.stringify({ pid: 99, label: 'killed run' }), { flag: 'wx' });
  const release = await acquire({ ...o, pid: 7, label: 'playwright', sleep: () => assert.fail('it waited on a dead holder') });
  assert.equal(JSON.parse(readFileSync(join(m.dir, 'slot-0.json'), 'utf8')).pid, 7);
  assert.deepEqual(m.log, []);
  release();
});

test('letting go removes only its own slot, so a run that lost its slot to a takeover can’t free another’s', async () => {
  const m = machine([7, 8]);
  const release = await acquire({ dir: m.dir, slots: 1, alive: m.alive, log: m.log1, pid: 7, label: 'a' });
  writeFileSync(join(m.dir, 'slot-0.json'), JSON.stringify({ pid: 8, label: 'b' }));
  release();
  assert.equal(existsSync(join(m.dir, 'slot-0.json')), true, 'pid 8’s slot is still there');
});

test('a slot file that isn’t JSON counts as free, as a damaged one would', async () => {
  const m = machine([7]);
  writeFileSync(join(m.dir, 'slot-0.json'), '{"pid":', { flag: 'wx' });
  const release = await acquire({ dir: m.dir, slots: 1, alive: m.alive, log: m.log1, pid: 7, label: 'a', sleep: () => assert.fail('it waited') });
  release();
});
