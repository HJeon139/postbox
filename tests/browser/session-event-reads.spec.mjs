// A session event costs the same in a room of 10,000 items as in one of 1,000 (#851). The transcript’s session
// listener looked for replies whose look on a host had changed (remoteStale, app/js/thread-host.mjs) by walking every
// item the page held of the thread, on every session event, the most frequent event while agents work. It now walks
// only the replies the transcript has drawn, so a session event reads none of the items the window hasn’t mounted.
// The page counts the reads of its items’ fields that a session event makes, and whose items they are.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, newestShown, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('session-event-reads', { demo: false });
  app.store.emit('project', { id: 'pr_reads', name: 'Reads', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** A room of `count` items, two agents’ replies and your messages, open in the page at its end. */
async function room(page, count) {
  const { rt } = app;
  const a = rt.createPersona({ handle: `maker${count}` });
  const b = rt.createPersona({ handle: `checker${count}` });
  const t = rt.createThread({ projectId: 'pr_reads', title: `${count} items`, personaIds: [a.id, b.id] });
  const [sa, sb] = arrange.sessionsIn(rt, t.id);
  for (let i = 0; i < count; i++) {
    const se = i % 2 ? sa : sb;
    if (i % 4 === 0) arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}: carry on.`, status: 'done' });
    else arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, handle: se.handle, turnId: `tu_${i}`, text: `Reply ${i}.`, status: 'done' });
  }
  // The page already open hears of the new room late, with the stream late: it waits for it before going there.
  if (page.url().startsWith(app.origin)) await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await newestShown(page, app, t.id);
  await synced(page, app);
  await settled(page);
  return { t, se: sa };
}

/**
 * One session event of `sessionId`, as the stream delivers it after a patch, with the reads of its items’ fields
 * meanwhile: how many, and the items read that the transcript hasn’t mounted. Then one that changes how the session’s
 * newest reply on the page looks, and whether that reply was drawn again.
 */
const readsOfOneEvent = (page, threadId, sessionId) =>
  page.evaluate(
    async ([tid, sid]) => {
      const { client } = await import('/app/js/client.mjs');
      const mounted = new Set([...document.querySelectorAll('#main > [data-key]')].map((n) => n.getAttribute('data-key')));
      // As it often comes: after a patch, which clears the latest reply the page keeps for the thread (#829, point 4).
      const last = client.state.items[tid].at(-1);
      client.emit({ type: 'item.patch', data: { threadId: tid, id: last.id, patch: {} } });
      // Each item is wrapped where it sits, so the list stays the one the page’s index knows (shared/item-index.mjs).
      const list = client.state.items[tid];
      const real = [...list];
      const target = real.findLast((it) => it.sessionId === sid && mounted.has(it.id));
      const before = document.querySelector(`#main > [data-key="${target.id}"]`);
      let reads = 0;
      const unmounted = new Set();
      for (let i = 0; i < list.length; i++)
        list[i] = new Proxy(real[i], {
          get(it, key, receiver) {
            reads++;
            if (!mounted.has(it.id)) unmounted.add(it.id);
            return Reflect.get(it, key, receiver);
          },
        });
      try {
        const data = { ...client.state.sessions[sid], currentStep: 'Reading the next file' };
        client.state.sessions[sid] = data;
        client.emit({ type: 'session', data });
      } finally {
        for (let i = 0; i < real.length; i++) list[i] = real[i];
      }
      // A second event says the session’s newest reply on the page ran on a host, which changes how that reply looks:
      // the listener finds it among the drawn replies and draws it again.
      const moved = { ...client.state.sessions[sid], remoteTurn: { rtTurn: target.turnId, state: 'running' } };
      client.state.sessions[sid] = moved;
      client.emit({ type: 'session', data: moved });
      return {
        reads,
        redrawn: document.querySelector(`#main > [data-key="${target.id}"]`) !== before,
        unmounted: [...unmounted],
        loaded: real.length,
        mounted: mounted.size,
      };
    },
    [threadId, sessionId],
  );

test('#851 a session event reads only the replies on the page, the same at 10,000 items as at 1,000', async ({ page }) => {
  test.setTimeout(120_000);
  const small = await room(page, 1_000);
  const one = await readsOfOneEvent(page, small.t.id, small.se.id);
  const large = await room(page, 10_000);
  const ten = await readsOfOneEvent(page, large.t.id, large.se.id);
  for (const [n, r] of [
    [1_000, one],
    [10_000, ten],
  ]) {
    expect(r.loaded, `the page holds more of the ${n}-item room than it mounts`).toBeGreaterThan(r.mounted);
    expect(r.redrawn, `at ${n} items, the reply whose look on a host changed is drawn again`).toBe(true);
    expect(r.unmounted, `at ${n} items, no item the window hasn’t mounted is read`).toEqual([]);
  }
  // What’s read is bounded by what the window mounts, which is about the same in both rooms, not by the room’s size.
  expect(ten.reads, 'ten times the items, within twice the reads').toBeLessThanOrEqual(2 * one.reads);
});
