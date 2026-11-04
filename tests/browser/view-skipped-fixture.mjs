// What the skipped-item specs share (#712a): a generated room (tools/uat/big-room.mjs) and a wait for the page to hold
// still that reads no item's rect.

import { expect } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';

/**
 * A generated room of `count` items, seeded into the running store: into `into` when given, else a new conversation.
 * opts: the rest of what bigRoomItems takes, such as `diagrams`.
 * @param {any} app @param {string} title @param {number} [count] @param {any} [into] @param {{ diagrams?: number }} [opts]
 */
export function bigRoom(app, title, count = 1000, into = null, opts = {}) {
  const { rt, store } = app;
  const project = /** @type {any} */ (Object.values(store.state.projects)[0]);
  const t = into ?? rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id] });
  const [se] = rt.sessionsIn(t.id);
  seedBigRoom(store, t.id, { ...opts, count }, { researcher: { sessionId: se.id, personaId: se.personaId } });
  return t;
}

/**
 * settled() without its per-item reads: its snapshot reads a rect of every `#main > *`, and at 10,000 items one poll
 * takes longer than the frames it compares. This waits for every scroll position, page height and published view to
 * hold for two frames.
 * @param {any} page
 */
export async function still(page, timeout = 10_000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const snap = () =>
            JSON.stringify([
              scrollY,
              document.scrollingElement?.scrollHeight,
              ...[...document.querySelectorAll('.transcript')].map((n) => {
                const t = /** @type {HTMLElement} */ (n);
                const box = /** @type {Element} */ (t.parentElement);
                return [box.scrollTop, box.scrollHeight, t.dataset.viewMode, t.dataset.viewAnchor, t.dataset.viewOffset];
              }),
            ]);
          const before = snap();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return snap() === before;
        }),
      { message: 'the page to hold still for two frames', timeout },
    )
    .toBe(true);
}

/**
 * Waits until no item of the transcript, nor the transcript, changes size for `quiet` frames in a row: a skipped item
 * drawing for the first time, or a diagram's frame sizing, comes in a later frame than the scroll that brought it near.
 * Its observer's first report, of every item's size, counts as a change.
 * @param {any} page @param {{ quiet?: number, timeout?: number }} [o]
 */
export async function quiet(page, { quiet = 5, timeout = 10_000 } = {}) {
  const held = await page.evaluate(
    ({ quiet, timeout }) =>
      new Promise((done) => {
        const el = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
        let calm = 0;
        const sizes = new ResizeObserver(() => {
          calm = 0;
        });
        sizes.observe(el);
        for (const n of el.children) sizes.observe(n);
        const end = performance.now() + timeout;
        const tick = () => {
          if (++calm > quiet || performance.now() > end) {
            sizes.disconnect();
            done(calm > quiet);
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { quiet, timeout },
  );
  expect(held, `no item changed size for ${quiet} frames`).toBe(true);
}
