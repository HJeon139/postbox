// Leaving a view lets go of its apps (#930). A room switch, or closing the side panel, takes every app’s frame off
// the page, but the page kept each one: in its set of mounted frames, until some frame posted a message or the theme
// changed, and as a target of a ResizeObserver per app and of the shared IntersectionObserver, which nothing ever
// unobserved. Whether the engine then keeps the frame alive is its own business; what the page holds is ours.
//
// Two observables, from init scripts, that no production code knows about:
// - Every ResizeObserver’s and IntersectionObserver’s observe, unobserve and disconnect are wrapped to keep a set of
//   each one’s targets. After a view goes, no .app-body that has left the page is still a target.
// - The set of mounted frames is read only through what the page does with it. A window resize sizes each frame in
//   it, which reads the frame’s isConnected first: the getter is wrapped to count reads on iframes that have left
//   the page. After a room switch, a resize reads none, so the set kept none of the old room’s frames. (A collection
//   count of live iframes after a switch isn’t a spec: a heap’s timing isn’t the page’s. The PR measures it.)

import { expect, test } from '@playwright/test';
import { frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const SWITCHES = 5;
const CODE = '<main style="padding:12px"><p>An app</p></main>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-release');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    /** @type {Map<object, Set<Element>>} each observer → what it observes */
    const targets = new Map();
    for (const Observer of [ResizeObserver, IntersectionObserver]) {
      const p = /** @type {any} */ (Observer.prototype);
      const { observe, unobserve, disconnect } = p;
      p.observe = function (target, ...rest) {
        if (!targets.has(this)) targets.set(this, new Set());
        targets.get(this).add(target);
        return observe.call(this, target, ...rest);
      };
      p.unobserve = function (target) {
        targets.get(this)?.delete(target);
        return unobserve.call(this, target);
      };
      p.disconnect = function () {
        targets.get(this)?.clear();
        return disconnect.call(this);
      };
    }
    w.pbGoneBodies = () => [...targets.values()].reduce((n, set) => n + [...set].filter((t) => t.matches('.app-body') && !t.isConnected).length, 0);
    const connected = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected'));
    w.pbGoneFrameReads = 0;
    Object.defineProperty(Node.prototype, 'isConnected', {
      ...connected,
      get() {
        const on = connected.get?.call(this);
        if (!on && this instanceof HTMLIFrameElement) w.pbGoneFrameReads++;
        return on;
      },
    });
  });
});

/** A room with n apps from @librarian, and a room with none to switch to. */
async function rooms(width, n) {
  const { rt } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const librarian = rt.personaByHandle('librarian').id;
  const apps = rt.createThread({ projectId, title: `Apps ${width}`, personaIds: [librarian] });
  const other = rt.createThread({ projectId, title: `Elsewhere ${width}`, personaIds: [] });
  rt.addItem(other.id, { kind: 'user', text: 'Nothing to see here.' });
  const tools = rt.toolsFor(rt.sessionsIn(apps.id)[0].id);
  const titles = Array.from({ length: n }, (_, i) => `App ${i + 1} at ${width}`);
  return { apps, other, tools, titles };
}

/** Shows each app, from the page, which runs its check, and waits until each passed and loaded. */
async function showAll(page, tools, titles, threadId) {
  for (const title of titles) {
    const id = `${title.replace(/\W+/g, '-')}-${threadId}`;
    tools.show_app({ id, title, code: CODE, permissions: [] });
    await expect.poll(() => app.rt.s.apps[id]?.check.status, { message: `${title} to pass its check` }).toMatch(/^(passed|note)$/);
    await expect(frameOf(page, title), `${title} to load`).toHaveAttribute('data-sized', '1');
  }
}

/** Goes to a room as its link does, and waits for its transcript. */
async function go(page, threadId) {
  await page.evaluate((id) => {
    location.hash = `#/t/${id}`;
  }, threadId);
  await expect(page.locator(`#main[data-thread="${threadId}"]`)).toBeAttached();
}

for (const width of [375, 1280])
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test(`#930 after ${SWITCHES} switches away from a room with 3 apps and back, no observer watches an app body that left the page`, async ({ page }) => {
      const r = await rooms(width, 3);
      await page.goto(`${app.origin}/#/t/${r.apps.id}`);
      await synced(page, app);
      await showAll(page, r.tools, r.titles, r.apps.id);
      for (let i = 1; i <= SWITCHES; i++) {
        await go(page, r.other.id);
        expect.soft(await page.evaluate(() => /** @type {any} */ (window).pbGoneBodies()), `switch ${i} away: app bodies gone but observed`).toBe(0);
        await go(page, r.apps.id);
        for (const title of r.titles) await expect(frameOf(page, title), `${title} back after switch ${i}`).toHaveAttribute('data-sized', '1');
        expect.soft(await page.evaluate(() => /** @type {any} */ (window).pbGoneBodies()), `switch ${i} back: app bodies gone but observed`).toBe(0);
      }
    });

    test('#930 after a room switch, a window resize touches none of the old room’s frames', async ({ page }) => {
      const r = await rooms(`${width} resize`, 3);
      await page.goto(`${app.origin}/#/t/${r.apps.id}`);
      await synced(page, app);
      await showAll(page, r.tools, r.titles, r.apps.id);
      await go(page, r.other.id);
      const reads = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const before = w.pbGoneFrameReads;
        // The page’s resize listeners run in this call, so what they read is counted before it returns.
        dispatchEvent(new Event('resize'));
        return w.pbGoneFrameReads - before;
      });
      expect(reads, 'reads of old frames by a resize after the switch').toBe(0);
    });

    test('#930 closing the side panel leaves no observer watching its app’s body', async ({ page }) => {
      const { rt } = app;
      const projectId = Object.values(rt.s.projects)[0].id;
      const t = rt.createThread({ projectId, title: `Side ${width}`, personaIds: [] });
      rt.addItem(t.id, { kind: 'user', text: 'The conversation.' });
      const side = rt.createThread({ projectId, title: `A side ${width}`, kind: 'side', parentId: t.id, personaIds: [rt.personaByHandle('librarian').id] });
      const tools = rt.toolsFor(rt.sessionsIn(side.id)[0].id);
      await page.goto(`${app.origin}/#/t/${t.id}/side/${side.id}`);
      await synced(page, app);
      const title = `In the side ${width}`;
      await showAll(page, tools, [title], side.id);
      await expect(page.locator('.sidepanel').locator(frameOf(page, title))).toBeAttached();
      await page.getByRole('button', { name: 'Close side thread' }).click();
      await expect(page.locator('.sidepanel')).toHaveCount(0);
      expect(await page.evaluate(() => /** @type {any} */ (window).pbGoneBodies()), 'app bodies gone but observed').toBe(0);
    });
  });
