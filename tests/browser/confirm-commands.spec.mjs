// #852 slice 1a: a confirmed command runs with no second card, so the confirm shows each command the agent named in
// its commands field, under the statement and outside Markdown, each in its own box that wraps: every byte is in view,
// at 375 and 1280 px, and none of it is folded away.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let agent;
test.beforeAll(async () => {
  app = await startPostbox('confirm-commands');
  app.rt.adapters.register({ name: 'mock', async deliver() {} });
  agent = app.rt.createPersona({ handle: 'pusher' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// A 300-character tail, with a 245-character run of no spaces that only wrapping anywhere keeps in view.
const TAIL = `&& gh pr merge 896 --admin --repo owner/postbox --body ${'q'.repeat(245)}`;
const LONG = `cd /home/me/postbox && gh pr edit 896 --repo owner/postbox --add-label ready ${TAIL}`;
const PUSH = 'git -C /home/me/postbox push origin wip/852-field';

/**
 * Where a command’s box and its text are.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} pre
 */
const measure = (page, pre) => {
  // Every non-space run of the command lies inside its box; spaces may hang at a wrap and carry nothing. And no
  // part of it is in Markdown, which could fold or restyle it, or in a details that could hide it.
  return pre.evaluate((el, edge) => {
    const box = el.getBoundingClientRect();
    const text = el.querySelector('code')?.firstChild;
    const past = [];
    for (const m of String(text?.textContent).matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(text, m.index);
      range.setEnd(text, m.index + m[0].length);
      for (const r of range.getClientRects()) if (r.right > box.right + 1 || r.left < box.left - 1) past.push(m[0]);
    }
    return {
      overflow: el.scrollWidth - el.clientWidth,
      inWindow: box.left >= 0 && box.right <= edge,
      clipped: el.scrollHeight - el.clientHeight,
      past,
      inMarkdown: Boolean(el.closest('.md, details')),
      oneTextNode: el.childNodes.length === 1 && el.firstChild?.nodeName === 'CODE' && el.firstChild.childNodes.length === 1,
    };
  }, windowWidth(page));
};

for (const width of [375, 1280])
  test(`#852 a confirm shows each command it runs, in view and outside Markdown (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { rt, store } = app;
    const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: `Commands ${width}`, personaIds: [agent.id] });
    rt.toolsFor(rt.sessionsIn(t.id)[0].id).show_block({
      block: {
        id: 'merge',
        type: 'confirm',
        version: 1,
        fallback: 'Merge #896?',
        statement: 'Label and merge **#896**.',
        confirmLabel: 'Merge #896',
        commands: [LONG, PUSH],
      },
    });
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const item = store.items(t.id).find((i) => i.kind === 'block');
    const block = page.locator(`#main [data-key="${item.id}"]`);
    await expect(block.getByText('Runs when you confirm', { exact: true })).toBeVisible();
    const pres = block.locator('pre.confirm-cmd');
    await expect(pres).toHaveCount(2);
    await expect(pres.nth(0)).toHaveText(LONG);
    await expect(pres.nth(1)).toHaveText(PUSH);
    await settled(page);
    for (const i of [0, 1]) {
      const pre = pres.nth(i);
      await expect(pre).toBeVisible();
      const shown = await measure(page, pre);
      expect.soft(shown, `command ${i} is all in view, as one text node, outside Markdown`).toEqual({
        overflow: 0,
        inWindow: true,
        clipped: 0,
        past: [],
        inMarkdown: false,
        oneTextNode: true,
      });
    }
    await expect(block.locator('.md').filter({ hasText: 'gh pr merge' })).toHaveCount(0);
  });
