// #852: a confirmed `gh … --body-file <path>` posts a file, so the confirm shows that file under its command: “Posts
// this file”, its path, size and SHA-256, and its text as plain text outside Markdown, wrapped so every byte is in view
// at 375 and 1280 px. A file longer than 40 lines shows its first 40, and says how many it has.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { confirmBodies } from '../../server/confirm-body.mjs';
import { failOnPageErrors, settled, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let agent;
let dir = '';
let path = '';
// 60 lines, the third a 245-character run of no spaces that only wrapping anywhere keeps in view.
const LINES = Array.from({ length: 60 }, (_, i) => (i === 2 ? `line-3-${'q'.repeat(245)}` : `Line ${i + 1} of the body`));
test.beforeAll(async () => {
  app = await startPostbox('confirm-body');
  app.rt.adapters.register({ name: 'mock', async deliver() {} });
  agent = app.rt.createPersona({ handle: 'poster' });
  // The project’s own repository, which a confirmed gh call must post to (#852 r3).
  const project = Object.values(app.store.state.projects)[0];
  app.store.emit('project', { ...project, pushUrl: 'https://github.com/owner/postbox.git' });
  dir = mkdtempSync(join(tmpdir(), 'pb-confirm-body-spec-'));
  path = join(dir, 'body.md');
  writeFileSync(path, `${LINES.join('\n')}\n`);
});
test.afterAll(async () => {
  await app?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
failOnPageErrors(test);

/**
 * Whether a body’s text is all in view in its box, as one text node, outside Markdown and any details.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} pre
 */
const measure = (page, pre) =>
  pre.evaluate((el, edge) => {
    const box = el.getBoundingClientRect();
    const text = el.querySelector('code')?.firstChild;
    const past = [];
    for (const m of String(text?.textContent).matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(text, m.index);
      range.setEnd(text, m.index + m[0].length);
      for (const r of range.getClientRects()) if (r.right > box.right + 1 || r.left < box.left - 1) past.push(m[0].slice(0, 20));
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

for (const width of [375, 1280])
  test(`#852 a confirm shows the file its command posts, its first 40 lines in view (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { rt, store } = app;
    const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: `Body ${width}`, personaIds: [agent.id] });
    const sessionId = rt.sessionsIn(t.id)[0].id;
    const args = {
      block: {
        id: 'pr',
        type: 'confirm',
        version: 1,
        fallback: 'Open the PR?',
        statement: 'Open the pull request.',
        confirmLabel: 'Open it',
        commands: [`gh pr create --repo owner/postbox --head feat/body --title "Show the body" --body-file ${path}`],
      },
    };
    // What the MCP step reads before show_block, as an agent’s call has it.
    const read = await confirmBodies(rt, sessionId, 'show_block', args);
    expect(read.ok, read.ok ? '' : read.why).toBe(true);
    const shown = rt.toolsFor(sessionId).show_block(args, { bodyFiles: read.ok ? read.bodyFiles : [] });
    expect(shown.ok, shown.message).toBe(true);
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const item = store.items(t.id).find((i) => i.kind === 'block');
    const block = page.locator(`#main [data-key="${item.id}"]`);
    const body = block.getByRole('group', { name: 'Posts this file' });
    await expect(body.getByText('Posts this file', { exact: true })).toBeVisible();
    await expect(body).toContainText(path);
    await expect(body).toContainText(item.bodyFiles[0].sha256.slice(0, 12));
    await expect(body.getByText('First 40 of 60 lines.', { exact: true })).toBeVisible();
    const pre = body.locator('pre.confirm-body');
    await expect(pre).toHaveCount(1);
    await expect(pre).toHaveText(LINES.slice(0, 40).join('\n'));
    await settled(page);
    expect.soft(await measure(page, pre), 'the body is all in view, as one text node, outside Markdown').toEqual({
      overflow: 0,
      inWindow: true,
      clipped: 0,
      past: [],
      inMarkdown: false,
      oneTextNode: true,
    });
    await expect(block.locator('.md, details').filter({ hasText: 'Line 1 of the body' })).toHaveCount(0);
  });
