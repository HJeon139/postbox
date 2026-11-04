// The UAT runner and the person’s view (#531, B1b-b): a screenshot the runner takes leaves the view as it was
// (tools/uat/driver-shots.mjs’s keepView), and the tester’s scroll reaches the page as the key a person presses
// (tools/uat/scroll-step.mjs). Both drive the runner’s own code against this page, through a stand-in for
// tools/browser.mjs’s page: evaluate, and send over the DevTools protocol.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { shots } from '../../tools/uat/driver-shots.mjs';
import { STEPS } from '../../tools/uat/steps.mjs';
import { failOnPageErrors, frames, settled, startPostbox } from './postbox.mjs';
import { holds, LONG, open as openIn, read, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {string} */
let dir;
test.beforeAll(async () => {
  app = await startPostbox('uat-view');
  dir = mkdtempSync(join(tmpdir(), 'uat-view-'));
});
test.afterAll(async () => {
  await app?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
failOnPageErrors(test);

/** tools/browser.mjs’s page, over this one: evaluate, and send, whose key presses `onKey` sees first. */
async function runnerPage(page, onKey = async () => {}) {
  const cdp = await page.context().newCDPSession(page);
  return {
    evaluate: (/** @type {string} */ expr) => page.evaluate(expr),
    send: async (/** @type {string} */ method, /** @type {any} */ params) => {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') await onKey(params.key);
      return cdp.send(/** @type {any} */ (method), params);
    },
  };
}

/** The shot’s wait for the page to draw, during which a reply streams in, a few words a frame. */
const streamIn = (/** @type {any} */ page, /** @type {any} */ t) => async () => {
  const { rt, store } = app;
  const [se] = rt.sessionsIn(t.id);
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  for (const word of `${LONG(80)} ${LONG(81)} ${LONG(82)}`.match(/\S+\s*/g) ?? []) {
    store.emit('item.text', { threadId: t.id, id: it.id, text: word });
    await frames(page);
  }
  rt.patchItem(t.id, it.id, { status: 'done' });
  await expect(page.locator(`[data-key="${it.id}"]`)).toContainText('Reply 82');
  await settled(page);
};

/** The runner’s shotItem, with the reply streaming in during its wait, and what it recorded. */
async function shoot(page, t, key) {
  const moved = [];
  const ev = (/** @type {string} */ expr) => page.evaluate(expr);
  const { shotItem } = shots({ ev, page: await runnerPage(page), sleep: streamIn(page, t), input: (m) => moved.push(m) });
  const file = await shotItem(key, join(dir, `${key}.png`));
  expect(file, 'the shot was taken').toBe(join(dir, `${key}.png`));
  await settled(page);
  return moved;
}

test('a shot of an item far above, with a reply streaming in meanwhile, leaves a following view following', async ({ page }) => {
  const { t } = roomIn(app, 'Runner view: following');
  await openIn(app, page, t);
  expect((await holds(page, t, 'opened')).mode).toBe('following');
  const moved = await shoot(page, t, app.store.state.items[t.id][2].id);
  const after = await holds(page, t, 'after the shot');
  expect(after.mode, 'still following, at the new end').toBe('following');
  expect(moved, 'nothing recorded as the runner’s').toEqual([]);
});

test('a shot of an item far above, with a reply streaming in meanwhile, puts a reading view back at its anchor', async ({ page }) => {
  const { t } = roomIn(app, 'Runner view: reading');
  await openIn(app, page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  const before = await holds(page, t, 'reading');
  expect(before.mode).toBe('reading');
  const moved = await shoot(page, t, app.store.state.items[t.id][2].id);
  const after = await holds(page, t, 'after the shot');
  expect(after.mode, 'still reading').toBe('reading');
  expect(after.anchor, 'at the same anchor').toBe(before.anchor);
  expect(Math.abs(Number(after.offset) - Number(before.offset)), 'at its offset, within 1 px').toBeLessThanOrEqual(1);
  expect(moved).toEqual([]);
});

test('scroll up reaches the page as PageUp from the composer: focusing the conversation moves nothing, the key moves the view', async ({ page }) => {
  const { t } = roomIn(app, 'Runner view: scroll');
  await openIn(app, page, t);
  await page.locator('#composer-input').click();
  await expect(page.locator('#composer-input')).toBeFocused();
  const facts = { probes: { inputs: /** @type {any[]} */ ([]) } };
  const top = () => page.evaluate(() => /** @type {Element} */ (document.scrollingElement).scrollTop);
  const start = await top();
  /** @type {any[]} */
  const atKey = [];
  const onKey = async (/** @type {string} */ key) => {
    atKey.push({ key, top: await top(), focused: await page.evaluate(() => document.activeElement?.id), inputs: facts.probes.inputs.length });
  };
  await STEPS.scroll({ page: await runnerPage(page, onKey), facts, step: 7 }, { by: 'up' });
  expect(atKey, 'at the key: the conversation focused, the view not moved, the input recorded').toEqual([
    { key: 'PageUp', top: start, focused: 'main', inputs: 1 },
  ]);
  expect(facts.probes.inputs.map((x) => [x.step, x.kind])).toEqual([[7, 'scroll']]);
  await expect.poll(async () => (await read(page, t)).mode, { message: 'PageUp scrolled the view up' }).toBe('reading');
  await settled(page);
  expect(await top(), 'up by about a page').toBeLessThan(start - 300);
  await holds(page, t, 'after PageUp');
  await STEPS.scroll({ page: await runnerPage(page), facts, step: 8 }, { by: 'end' });
  await expect.poll(async () => (await read(page, t)).mode, { message: 'End brought it back to the end' }).toBe('following');
});
