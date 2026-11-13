// The demo’s showcase story (tools/demo-showcase.mjs): each replay of a recorded real session plays to its end in the
// demo, with the recorded words, both app versions and @critic’s pinned comments, each resolved; its turns report the
// recorded costs; and its app runs only in a sandboxed frame, served with `sandbox allow-scripts`, at an opaque origin.

import { expect, test } from '@playwright/test';
import { client } from '../../tools/demo-client.mjs';
import { replay, replayTitle, SHOWCASE, story } from '../../tools/demo-showcase.mjs';
import { startPostbox } from './postbox.mjs';

/** An app id as a CSS attribute value: the recordings’ ids are plain, but quotes and backslashes are escaped. */
const CSS_ESCAPE = (/** @type {string} */ id) => id.replace(/["\\]/g, '\\$&');

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('showcase');
});
test.afterAll(() => app?.stop());

test('each replayed turn is the real turn its rule names, with that turn’s words, version and cost', () => {
  for (const key of SHOWCASE) {
    const st = story(key);
    const builder = st.recordedTurns.filter((t) => t.handle === 'builder');
    const { build, critique, revise } = st.turns;
    // The rule (tools/demo/showcase/README.md): @builder’s turn that handed the app to @critic, @critic’s first
    // review, and @builder’s first turn that started after that review.
    expect(build.turnId, `${key}: the build is the handoff`).toBe(builder.find((t) => t.said.some((x) => /@critic/.test(x)))?.id);
    expect(revise.turnId, `${key}: the revision is the first turn after the review`).toBe(builder.find((t) => t.startedAt >= critique.reviewedAt - 1)?.id);
    for (const [t, version] of [
      [build, build.app.version],
      [revise, revise.app.version],
    ]) {
      const real = st.recordedTurns.find((x) => x.id === t.turnId);
      expect(real.versions.at(-1), `${key}: the last version the turn made`).toBe(version);
      for (const words of [t.say].flat()) expect(real.said, `${key}: words of the turn that made v${version}`).toContain(words);
      expect(t.costUsd, `${key}: that turn’s cost`).toBeCloseTo(real.costUsd, 4);
    }
    const reviewTurn = st.recordedTurns.find((x) => x.id === critique.turnId);
    expect(reviewTurn.said).toContain(critique.say);
    // Every real turn is replayed or named as left out.
    const named = [build.turnId, critique.turnId, revise.turnId, ...st.notReplayed].sort();
    expect(named).toEqual(st.recordedTurns.map((t) => t.id).sort());
  }
});

/**
 * The origin v2’s frame runs at, in the app’s own item (not the review’s copy), or null while it isn’t loaded. The
 * transcript redraws an item as it scrolls into its window, and the page loads an app’s frame only near the window,
 * so nothing is held across a redraw: each call finds the item by its app id in the page, scrolls it into view, and
 * reads the frame afresh from the page’s frames by its v2 source.
 * @param {import('@playwright/test').Page} page @param {string} appId @param {string} src
 */
async function v2Origin(page, appId, src) {
  const sel = `.app-body[data-app-id="${CSS_ESCAPE(appId)}"]:not(.app-review-wrap .app-body)`;
  const shown = await page.evaluate(
    ({ sel, src }) => {
      const item = [...document.querySelectorAll(sel)].at(-1);
      item?.scrollIntoView({ block: 'center' });
      return !!item?.querySelector(`iframe[src*="${src}?"]:not([src*="check"])`);
    },
    { sel, src },
  );
  if (!shown) return null;
  const own = (/** @type {string} */ url) => url.includes(`${src}?`) && !/[?&]check/.test(url);
  return (
    (await page
      .frames()
      .find((f) => own(f.url()))
      ?.evaluate(() => self.origin)
      .catch(() => null)) ?? null
  );
}

test('every showcase replay plays to v2 with its recorded words, comments and costs, in a sandboxed frame', async ({ page }) => {
  test.setTimeout(240_000);
  const { origin } = app;
  const c = client(origin);
  await c.call('/api/demo/speed', { speed: 0.1 });
  await page.goto(`${origin}/`);
  for (const key of SHOWCASE) {
    const st = story(key);
    const { thread } = await replay(c, key, { view: (hash) => page.goto(`${origin}/${hash}`).then(() => {}) });
    // Opened again once it’s played: with the server’s events late, the first open can come before the page heard of the room.
    await page.goto(`${origin}/#/t/${thread.id}`);
    await expect(page.locator('.topbar')).toContainText(replayTitle(st), { timeout: 15_000 });
    // The recorded words: the revision’s reply, and each of @critic’s comments on the review block.
    const state = await c.state();
    const items = c.items(state, state.threads[thread.id]);
    expect(items.some((i) => i.kind === 'agent' && i.text?.includes(st.turns.revise.say.slice(0, 120)))).toBe(true);
    const review = items.find((i) => i.block?.id === st.turns.critique.blockId);
    expect(review.block.threads.map((t) => t.comments[0])).toEqual(st.turns.critique.comments.map((x) => ({ author: '@critic', text: x.text })));
    // The Work view’s turns carry the recorded costs: Claude Code’s in dollars, Codex’s as none. The replayed turns
    // are the room’s first three; the page’s check of v2 can hand @builder a turn of its own after them (#1309).
    const costs = state.work[thread.id]
      .filter((e) => e.kind === 'turn')
      .slice(0, 3)
      .map((e) => e.costUsd ?? null);
    expect(costs).toEqual([st.turns.build.costUsd, st.turns.critique.costUsd, st.turns.revise.costUsd]);
    // v2 is what the frame shows, sandboxed: served with the sandbox policy, at an opaque origin.
    const appId = st.turns.build.app.id;
    expect(state.apps[appId].versions[1].code.length).toBeGreaterThan(1000);
    const src = `/sandbox/app/${encodeURIComponent(appId)}/2`;
    const res = await page.request.get(`${origin}${src}?theme=light`);
    expect(res.headers()['content-security-policy']).toContain('sandbox allow-scripts');
    expect(res.headers()['content-security-policy']).not.toContain('allow-same-origin');
    // The page shows v2 once its own check has passed it, and loads an app’s frame as it comes near the window. The
    // transcript redraws an item as it scrolls into its window, so no element is held across that: each poll finds
    // the app’s own item (not the review’s copy) by its app id in the page, scrolls it into view and checks its frame.
    await c.until((s) => s.apps[appId].current === 2 && ['passed', 'note'].includes(s.apps[appId].check.status) && s, {
      label: `${key}’s v2 to pass its check`,
      timeout: 60_000,
    });
    await expect.poll(() => v2Origin(page, appId, src), { timeout: 30_000 }).toBe('null');
  }
});
