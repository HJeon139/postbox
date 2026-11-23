// #438: an agent’s app that keeps animating with no input from the person is reported by the app page’s kit
// (app/kit/frames.js), and its agent hears it at its next turn, once for each version. A report for an older version
// or a retired app goes nowhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { appAnimating } from '../server/app-animating.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

function shown() {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', async folderFor() {}, fork() {}, async deliver() {} }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'editor' }).id] });
  const se = arrange.agentIn(rt, t.id, 'editor');
  const tools = rt.toolsFor(se.id);
  const { appId } = tools.show_app({ title: 'Reaction rates', code: '<canvas></canvas>' });
  const heard = () => (rt.s.sessions[se.id].context ?? []).filter((line) => line.includes('kept animating'));
  return { rt, tools, appId, heard };
}

test('#438 an app that keeps animating is reported to its agent once, for the version that does it', () => {
  const s = shown();
  assert.deepEqual(appAnimating(s.rt, s.appId, 1), { ok: true, told: true });
  assert.deepEqual(appAnimating(s.rt, s.appId, 1), { ok: true, told: false }, 'the same version again');
  assert.equal(s.heard().length, 1);
  assert.match(
    s.heard()[0],
    /^\[Postbox\] Your app “Reaction rates” v1 kept animating for 30 seconds with no input from the person, drawing every frame\. Make its loop stop on its own: when its state stops changing, at a time limit, or after a set number of steps\./,
  );
  s.tools.update_app({ id: s.appId, code: '<canvas id="v2"></canvas>', summary: 'stops at rest' });
  assert.deepEqual(appAnimating(s.rt, s.appId, 1), { ok: true, told: false }, 'an older version');
  assert.deepEqual(appAnimating(s.rt, s.appId, 2), { ok: true, told: true }, 'the new version that does it too');
  assert.equal(s.heard().length, 2);
});

test('#438 a report for an unknown app is refused, and one for a retired app or a version that isn’t a number goes nowhere', () => {
  const s = shown();
  for (const id of ['no-such-app', 'constructor', '__proto__'])
    assert.throws(
      () => appAnimating(s.rt, id, 1),
      (e) => e.status === 404,
      id,
    );
  assert.deepEqual(appAnimating(s.rt, s.appId, '1'), { ok: true, told: false });
  s.tools.retire_app({ id: s.appId, reason: 'Replaced.' });
  assert.deepEqual(appAnimating(s.rt, s.appId, 1), { ok: true, told: false });
  assert.deepEqual(s.heard(), []);
});
