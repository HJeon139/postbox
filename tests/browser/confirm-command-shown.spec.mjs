// #852 slice 1a, threat C9: a confirmed command runs with no second card, so the person must see every byte of it on
// the confirm. A code block in a statement scrolled sideways, so a long line could hide its tail past the edge (after a
// run of spaces, say). In a confirm the code wraps: nothing is past the edge, at 375 and 1280 px.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let agent;
test.beforeAll(async () => {
  app = await startPostbox('confirm-command-shown');
  app.rt.adapters.register({ name: 'mock', async deliver() {} });
  agent = app.rt.createPersona({ handle: 'pusher' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const TAIL = '&& gh pr merge 896 --admin';
const COMMAND = `gh pr edit 896 --add-label "ready for integrator"${' '.repeat(400)}${TAIL}`;

for (const width of [375, 1280])
  test(`#852 a confirm’s command shows every byte, with nothing past the edge (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { rt, store } = app;
    const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: `Confirm ${width}`, personaIds: [agent.id] });
    rt.toolsFor(rt.sessionsIn(t.id)[0].id).show_block({
      block: {
        id: 'label',
        type: 'confirm',
        version: 1,
        fallback: 'Label it?',
        statement: `Confirming runs:\n\n\`\`\`\n${COMMAND}\n\`\`\``,
        confirmLabel: 'Label #896',
      },
    });
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const item = store.items(t.id).find((i) => i.kind === 'block');
    const code = page.locator(`#main [data-key="${item.id}"] pre`);
    await expect(code).toContainText(TAIL);
    // Every non-space run of the command, the tail included, lies inside the block; spaces may hang at a wrap, as
    // they do in any wrapped text, and carry nothing.
    const fit = await code.evaluate((pre) => {
      const box = pre.getBoundingClientRect();
      const text = pre.firstChild?.firstChild ?? pre.firstChild;
      const past = [];
      for (const m of String(text.textContent).matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(text, m.index);
        range.setEnd(text, m.index + m[0].length);
        for (const r of range.getClientRects()) if (r.right > box.right + 1 || r.left < box.left - 1) past.push(m[0]);
      }
      return { overflow: pre.scrollWidth - pre.clientWidth, past };
    });
    expect(fit, 'no part of the command is past the code block’s edge').toEqual({ overflow: 0, past: [] });
  });
