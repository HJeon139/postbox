// How a host-mode UAT run accounts for what it leaves on a host (#120): its own folder counts as made before the
// script that makes it answers, a Remove counts as done only when confirmed, and a Stop is judged only after a look at
// the host just before it worked. No ssh and no page: the runner’s ssh, its Remove through the UI and its process
// probe are fakes, and the probe prints what tests/uat-hosts-facts.mjs recorded the shape of.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUp } from '../tools/uat/hosts-end.mjs';
import { makeRunFolder } from '../tools/uat/hosts-run.mjs';
import { beforeStop, leftBy } from '../tools/uat/hosts-watch.mjs';
import { TREE_AFTER, TREE_BEFORE, TURN } from './uat-hosts-facts.mjs';

const DEST = 'host.example.com';
/** A host run with one host, set up, as cleanUp and the probes read it. */
function hostRun(over = {}) {
  const lines = [];
  const h = { label: 'host1', destination: DEST, settings: {}, id: 'ho_1', home: '/home/user', made: /** @type {any} */ ({ parent: false }) };
  const hr = /** @type {any} */ ({
    hosts: [h],
    placement: { researcher: 'host1' },
    stamp: 'r1',
    kit: {},
    log: (/** @type {string} */ l) => lines.push(l),
    samples: new Map(),
    trees: new Map(),
    record: {},
    ...over,
  });
  return { hr, h, lines };
}
const done =
  (stdout = 'removed\n') =>
  async () => ({ code: 0, stdout, stderr: '' });
const GONE = { confirm: `Remove ${DEST}?`, exists: false, left: [] };

test('#120 UAT cleanup: a Remove the end of the run recorded as failed is tried again, and a confirmed one isn’t', async () => {
  const failed = hostRun({ record: { ended: true, removed: { host1: { error: 'The runner’s ssh to host1 dropped.' } } } });
  const calls = [];
  await cleanUp(failed.hr, {
    removeOne: async (_hr, h) => {
      calls.push(h.label);
      return GONE;
    },
    run: done(),
  });
  assert.deepEqual(calls, ['host1']);
  assert.deepEqual(failed.hr.record.cleanup, { host1: GONE });
  assert.deepEqual(failed.lines, ['Removed Postbox from host1.']);
  assert.equal(failed.h.made, null, 'its folder went too');

  const confirmed = hostRun({ record: { ended: true, removed: { host1: GONE } } });
  confirmed.h.made = null;
  await cleanUp(confirmed.hr, { removeOne: async () => assert.fail('a confirmed Remove isn’t tried again'), run: done() });
  assert.deepEqual(confirmed.lines, []);
});

test('#120 UAT cleanup: what still can’t be removed says what to run by hand, with the host’s destination', async () => {
  const again = hostRun({ record: { ended: true, removed: { host1: { error: 'Remove was refused.' } } } });
  await cleanUp(again.hr, {
    removeOne: async () => ({ error: 'Couldn’t find the host’s Remove.' }),
    run: async () => ({ code: 1, stdout: '', stderr: '~/postbox-uat/r1 is still there.' }),
  });
  assert.equal(again.lines.length, 2);
  assert.match(
    again.lines[0],
    /Couldn’t remove ~\/postbox-uat\/r1 from host1: ~\/postbox-uat\/r1 is still there\. On host\.example\.com, run: rm -rf ~\/postbox-uat\/r1/,
  );
  assert.match(again.lines[1], /Postbox may still be on host1: Couldn’t find the host’s Remove\. On host\.example\.com, stop what pgrep/);
  assert.deepEqual(again.h.made, { parent: false }, 'the folder still counts as the run’s');
  // Remove went through Postbox but left the daemon running: the host is gone from Postbox, so only by hand.
  const left = hostRun({ record: { ended: true, removed: { host1: { ...GONE, left: ['4000 node host.mjs serve'] } } } });
  await cleanUp(left.hr, { removeOne: async () => assert.fail('a Remove that went through isn’t tried again'), run: done() });
  assert.match(left.lines[0], /Postbox may still be on host1: still running: 4000 node host\.mjs serve\./);
});

test('#120 UAT cleanup: the run’s folder is the run’s before workScript answers, unless it refused one already there', async () => {
  const lost = hostRun();
  lost.h.made = null;
  await assert.rejects(makeRunFolder(lost.hr, lost.h, { run: async () => ({ code: 255, stdout: '', stderr: 'Connection reset by peer' }) }), /exit 255/);
  assert.deepEqual(lost.h.made, { parent: false }, 'a reply ssh lost leaves the folder to cleanUp');
  const there = hostRun();
  await assert.rejects(makeRunFolder(there.hr, there.h, { run: async () => ({ code: 3, stdout: '', stderr: 'already there' }) }), /already there/);
  assert.equal(there.h.made, null, 'a folder that was there already isn’t the run’s');
  const made = hostRun();
  await makeRunFolder(made.hr, made.h, { run: done('made\n') });
  assert.deepEqual(made.h.made, { parent: true });
});

const ok = (out) => async () => ({ out, why: null });
const AFTER_CLEAN = TREE_AFTER.split('\n')
  .filter((l) => !/ 43\d\d /.test(l))
  .join('\n');

test('#120 UAT Stop: a failed look just before Stop leaves it unjudged, whatever older looks saw, until a later one works', async () => {
  const { hr, h } = hostRun();
  const opts = { measure: ok(AFTER_CLEAN), wait: async () => {} };
  await beforeStop(hr, { measure: ok(TREE_BEFORE) });
  assert.deepEqual(await leftBy(hr, h, TURN, Date.now(), opts), { watched: 4, left: [] });
  // A background shell may have started since that look, and this one failed.
  await beforeStop(hr, { measure: async () => ({ out: null, why: 'ssh: connect to host host.example.com port 22: Operation timed out' }) });
  const got = await leftBy(hr, h, TURN, Date.now(), opts);
  assert.equal(got.left, null);
  assert.match(String(got.unmeasured), /just before Stop failed \(ssh: connect to host host\.example\.com port 22: Operation timed out\)/);
  await beforeStop(hr, { measure: ok(TREE_BEFORE) });
  assert.deepEqual(await leftBy(hr, h, TURN, Date.now(), opts), { watched: 4, left: [] });
  // No look before Stop at all can’t be judged either.
  const fresh = hostRun();
  fresh.hr.trees = hr.trees;
  assert.equal((await leftBy(fresh.hr, fresh.h, TURN, Date.now(), opts)).left, null);
});
