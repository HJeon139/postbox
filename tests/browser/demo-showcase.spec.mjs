// The demo’s showcase story (tools/demo-showcase.mjs): each replay of a recorded real session plays to its end in the
// demo, with the recorded words, both app versions and @critic’s pinned comments, each resolved; its turns report the
// recorded costs; and its app runs only in a sandboxed frame, served with `sandbox allow-scripts`, at an opaque origin.

import { expect, test } from '@playwright/test';
import { client } from '../../tools/demo-client.mjs';
import { replay, replayTitle, SHOWCASE, story } from '../../tools/demo-showcase.mjs';
import { startPostbox } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('showcase');
});
test.afterAll(() => app?.stop());

test('each replayed turn says the words of the recorded turn whose app version it shows', () => {
  for (const key of SHOWCASE) {
    const st = story(key);
    const turn = (id) => st.recordedTurns.find((t) => t.id === id);
    const [build, critique, revise] = [st.turns.build, st.turns.critique, st.turns.revise].map((t) => ({ t, real: turn(t.turnId) }));
    for (const { t, real } of [build, revise]) {
      const version = t === st.turns.build ? t.app.version : st.turns.revise.app.version;
      expect(real?.versions, `${key}: the turn that made v${version}`).toContain(version);
      for (const words of [t.say].flat()) expect(real.said, `${key}: words of the turn that made v${version}`).toContain(words);
    }
    expect(critique.real.said).toContain(st.turns.critique.say);
  }
});

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
    // The Work view’s turns carry the recorded costs: Claude Code’s in dollars, Codex’s as none.
    const costs = state.work[thread.id].filter((e) => e.kind === 'turn').map((e) => e.costUsd ?? null);
    expect(costs).toEqual([st.turns.build.costUsd, st.turns.critique.costUsd, st.turns.revise.costUsd]);
    // v2 is what the frame shows, sandboxed: served with the sandbox policy, at an opaque origin.
    const appId = st.turns.build.app.id;
    expect(state.apps[appId].versions[1].code.length).toBeGreaterThan(1000);
    const src = `/sandbox/app/${encodeURIComponent(appId)}/2`;
    const res = await page.request.get(`${origin}${src}?theme=light`);
    expect(res.headers()['content-security-policy']).toContain('sandbox allow-scripts');
    expect(res.headers()['content-security-policy']).not.toContain('allow-same-origin');
    await expect
      .poll(async () => {
        const frame = page.frames().find((f) => f.url().includes(src) && !f.url().includes('check'));
        return frame ? frame.evaluate(() => self.origin).catch(() => null) : null;
      })
      .toBe('null');
  }
});
