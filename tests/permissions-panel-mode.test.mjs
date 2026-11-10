// What setPermissionMode answers, and the permissions view lists, about a turn that runs while its mode changes
// (#1030), from server/permissions-panel.mjs. A turn loads the person’s hooks when it starts, in Auto and Run
// everything only (#806), and keeps them, or their absence, until it ends. So the answer names the turns Postbox
// keeps in their mode (switchesLive, kept), apart from those a backend can’t change, and the turns that switched live
// into a mode with hooks they never loaded (hooksLater); the view lists the running turns that loaded them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveControl } from '../server/adapters/agent-sdk.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** A running query that records each mode the adapter sets on it. */
const query = () => {
  const modes = [];
  return { modes, setPermissionMode: async (m) => modes.push(m) };
};

/** A held turn of alpha’s that started in `mode`, with the Agent SDK’s live control on `q`, or none for the CLI. */
async function runningIn(mode, q = query()) {
  const f = setup();
  f.rt.updatePersona(f.a.id, { permissionMode: mode });
  const h = held();
  f.adapter.next.push(async (ctx) => {
    if (q) ctx.control(liveControl(q, ctx.persona.permissionMode));
    await h.step(ctx);
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha run the tests' });
  await sleep(5);
  return { ...f, q, h };
}

test('#1030: Auto, then Run everything live, then Ask me: the third is kept by Postbox, and the turn stays in Run everything', async () => {
  const { rt, a, alpha, q, h } = await runningIn('auto');
  assert.deepEqual(await rt.setPermissionMode(a.id, 'bypass'), { ok: true, now: [alpha.id], later: [], kept: [], hooksLater: [] });
  assert.deepEqual(await rt.setPermissionMode(a.id, 'ask'), { ok: true, now: [], later: [alpha.id], kept: [alpha.id], hooksLater: [] });
  assert.deepEqual(q?.modes, ['bypassPermissions'], 'the running turn stays in Run everything');
  h.release();
  await settle(rt);
});

test('#1030: a CLI turn that can’t change at all is kept for its backend’s reason, not listed as Postbox keeping it', async () => {
  const { rt, a, alpha, h } = await runningIn('auto', null);
  assert.deepEqual(await rt.setPermissionMode(a.id, 'ask'), { ok: true, now: [], later: [alpha.id], kept: [], hooksLater: [] });
  h.release();
  await settle(rt);
});

test('#1030: a switch Postbox allows but the SDK refuses is kept for the backend’s reason, not listed as Postbox keeping it', async () => {
  const refuses = { setPermissionMode: async () => Promise.reject(new Error('Only available in streaming input mode')) };
  const { rt, a, alpha, h } = await runningIn('auto', /** @type {any} */ (refuses));
  assert.deepEqual(await rt.setPermissionMode(a.id, 'bypass'), { ok: true, now: [], later: [alpha.id], kept: [], hooksLater: [] });
  h.release();
  await settle(rt);
});

test('#1030: the panel lists the running turns that loaded the hooks, whatever the mode is now', async () => {
  const sdk = await runningIn('auto');
  await sdk.rt.setPermissionMode(sdk.a.id, 'ask');
  const kept = await sdk.rt.permissionsView({ sessionId: sdk.alpha.id });
  assert.deepEqual([kept.running, kept.hooksRunning], [['alpha'], ['alpha']], 'Ask me now, and its Auto turn still runs the hooks');
  sdk.h.release();
  await settle(sdk.rt);
  assert.deepEqual((await sdk.rt.permissionsView({ sessionId: sdk.alpha.id })).hooksRunning, [], 'none once it ends');
  const off = await runningIn('ask');
  await off.rt.setPermissionMode(off.a.id, 'auto');
  const live = await off.rt.permissionsView({ sessionId: off.alpha.id });
  assert.deepEqual([live.running, live.hooksRunning], [['alpha'], []], 'Auto now, and its Ask me turn never loaded them');
  off.h.release();
  await settle(off.rt);
});
