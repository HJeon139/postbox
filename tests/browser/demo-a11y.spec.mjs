// Every scene of the demo passes axe-core (WCAG 2.1 A and AA) at 1280 and 375 px, in dark and in light: CI’s gate on
// the demo, moved here from tools/shoot-app.mjs so every browser check runs on Playwright Test (#303). It plays the
// scenes of tools/demo.mjs, the ones the screenshot tool shoots, with the same speed and the same prepare steps.
//
// The scenes are in GROUPS, each a test that can run on a worker, and on a CI shard, of its own. play() builds every
// scene on the ones before it, against one Postbox, so each group’s test starts a Postbox of its own and plays the
// demo from the start: the scenes before its group play without being checked, and it stops after its group’s last.
// As one test, all 23 scenes took 220 s on CI’s runner, and held up the shard it ran in by three minutes.
//
// The test’s own page stays on each scene’s conversation at desktop size, as a person’s would, so agent apps get
// checked there before they’re shown. Each variant loads the scene fresh, in a context of its own, with ?nocheck, as
// the screenshot tool’s second browser does. axe can’t enter an agent app: it’s a sandboxed frame with an opaque
// origin, and the app’s own check covers labels, contrast and overflow inside it.
//
// It watches its pages’ errors itself rather than with failOnPageErrors, which can’t allow an exception: the demo’s
// errors scene crashes an app and takes the server offline on purpose.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { expect, test } from '@playwright/test';
import { play } from '../../tools/demo.mjs';
import { settled, startPostbox, synced } from './postbox.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const VARIANTS = [
  { theme: 'dark', width: 1280, height: 900, scale: 1 },
  { theme: 'light', width: 1280, height: 900, scale: 1 },
  { theme: 'dark', width: 375, height: 812, scale: 2 },
  { theme: 'light', width: 375, height: 812, scale: 2 },
];
// How many variants load at once. All four only with cores to spare: on CI’s 4-core runner, with 4 workers, four
// contexts a scene left each page behind the event stream, and “the page to hear event” timed out in every repeat.
// POSTBOX_A11Y_AT_ONCE overrides it.
const AT_ONCE = Math.min(VARIANTS.length, Number(process.env.POSTBOX_A11Y_AT_ONCE) || (availableParallelism() >= 8 ? VARIANTS.length : 1));

/**
 * What the demo’s errors scene (“Index the shelf”) causes on purpose: the shelf map’s script error, which crashes it,
 * and the requests that fail while the server plays offline.
 */
const MEANT = [
  /Cannot read properties of undefined \(reading 'map'\)/,
  /Failed to load resource: .*(503|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED)/,
];
/**
 * The exceptions a page throws and the errors it logs from now on, except those MEANT while inScene() says it’s on
 * the errors scene.
 * @param {import('@playwright/test').Page} page  @param {() => boolean} inScene
 */
function errorsOf(page, inScene) {
  /** @type {string[]} */
  const errors = [];
  const add = (/** @type {string} */ text) => (inScene() && MEANT.some((p) => p.test(text))) || errors.push(text);
  page.on('pageerror', (e) => add(`exception: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && add(`console.error: ${m.text()}`));
  return errors;
}

// No step may wait longer than this for an element: a step that can’t act fails here, not at the test’s timeout.
const ACT = { timeout: 10_000 };

/**
 * A scene’s prepare steps (tools/demo.mjs, UI) on a page, clicking and typing through Playwright. Each acts on the
 * first element a selector finds, as the steps are written: “the first citation”, “the first changed file”.
 * @param {import('@playwright/test').Page} page
 * @returns {import('../../tools/demo.mjs').UI}
 */
function ui(page) {
  /** @param {string} sel  @param {string} [text] */
  const find = (sel, text) => (text ? page.locator(sel).filter({ hasText: text }) : page.locator(sel)).first();
  return {
    click: (sel, text) => find(sel, text).click(ACT),
    // A real click where it’s visible. Where the layout hides it, and the scene shows it anyway, no click can reach it:
    // there it gets the click event.
    activate: async (sel, text) => {
      const node = find(sel, text);
      await node.waitFor({ state: 'attached', ...ACT });
      await ((await node.isVisible()) ? node.click(ACT) : node.dispatchEvent('click', undefined, ACT));
    },
    press: (sel, key) => find(sel).press(key, ACT),
    fill: (sel, value) => find(sel).fill(value, ACT),
    attach: (sel, file) => find(sel).setInputFiles(file, ACT),
    scroll: (sel) => find(sel).evaluate((n) => n.scrollIntoView({ block: 'center' }), undefined, ACT),
    shows: (sel, text) => expect(find(sel, text)).toBeVisible(ACT),
  };
}

/**
 * Until the scene has finished drawing: no app still being checked, all math rendered, every animation that ends
 * ended, and the layout holding still. axe on a card halfway through fading in finds its contrast too low. An app
 * frame’s height doesn’t matter to axe, which can’t enter it, so this doesn’t wait for frames to be sized: a second
 * frame of the same app, far above the window, may never be (#407).
 * @param {import('@playwright/test').Page} page
 */
async function drawn(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => [
          ...[...document.querySelectorAll('.app-placeholder')].filter((p) => /Checking/.test(p.textContent ?? '')).map(() => 'an app being checked'),
          ...[...document.querySelectorAll('.md-math:not(.rendered)')].map(() => 'math not rendered yet'),
          ...document
            .getAnimations()
            .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
            .map((a) => `an animation running: ${/** @type {any} */ (a).animationName ?? /** @type {any} */ (a).transitionProperty}`),
        ]),
      { message: 'apps checked, math rendered and animations ended', timeout: 15_000 },
    )
    .toEqual([]);
  await settled(page);
}

/**
 * What axe finds on the whole page against WCAG 2.1 A and AA: each rule, with up to five of the nodes it found.
 * @param {import('@playwright/test').Page} page
 */
async function axe(page) {
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover, as a tag it loads would be.
  await page.evaluate(`${AXE};0`);
  return page.evaluate(() =>
    /** @type {any} */ (window).axe
      .run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
      .then((/** @type {any} */ r) =>
        r.violations.map((/** @type {any} */ v) => ({
          rule: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 5).map((/** @type {any} */ n) => n.target.join(' ')),
        })),
      ),
  );
}

/**
 * The demo’s scenes, in the order play() shows them, in groups that take about as long on CI’s runner: a later group
 * checks fewer scenes, as it plays more of the demo before its first.
 */
const GROUPS = [
  ['02-empty', '04-corpus-app', '06-catalog', '05-explainer'],
  ['16-narration', '18-topic-thread', '19-threads', '07-review', '03-thread', '08-wakes'],
  ['09-errors', '10-plus-menu', '11-new-agent', '15-permission', '15b-refusal', '14-charts', '20-diagram-lint'],
  ['21a-work-chip', '21-work', '21b-work-file', '01-needs-you', '12-agent-panel', '13-delete-confirm'],
];
// Each group’s test has a Postbox to itself, so the groups can run at once, on whichever workers are free.
test.describe.configure({ mode: 'parallel' });

/** What a group’s test throws once its last scene is checked, to stop play() there. */
const ENOUGH = new Error('the group’s last scene is checked');

/**
 * Checks one scene in every variant, AT_ONCE at a time: each is a context of its own, and one after another they were
 * most of the suite’s time. The errors scene’s prepare step puts the server offline in each, which the others ride out.
 * @param {import('@playwright/test').Browser} browser  @param {Awaited<ReturnType<typeof startPostbox>>} app
 * @param {string} name  @param {string} hash  @param {((ui: import('../../tools/demo.mjs').UI) => Promise<void>) | undefined} prepare
 */
async function checkScene(browser, app, name, hash, prepare) {
  for (let i = 0; i < VARIANTS.length; i += AT_ONCE)
    await Promise.all(
      VARIANTS.slice(i, i + AT_ONCE).map(({ theme, width, height, scale }) => {
        const variant = `${theme} at ${width} px`;
        return test.step(variant, async () => {
          const context = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: scale,
            isMobile: width < 768,
            colorScheme: /** @type {'dark' | 'light'} */ (theme),
          });
          try {
            const shown = await context.newPage();
            const shownErrors = errorsOf(shown, () => name === '09-errors');
            await shown.goto(`${app.origin}/?nocheck${hash}`);
            await synced(shown, app);
            await drawn(shown);
            if (prepare) {
              await prepare(ui(shown));
              await drawn(shown);
            }
            expect.soft(await axe(shown), `axe in ${name}, ${variant}`).toEqual([]);
            expect.soft(shownErrors, `${name}, ${variant}: the page threw no exceptions and logged no errors`).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }),
    );
}

/**
 * Plays the demo on a fresh Postbox until a group’s last scene, and checks that group’s scenes.
 * @param {import('@playwright/test').Page} page  @param {import('@playwright/test').Browser} browser
 * @param {Awaited<ReturnType<typeof startPostbox>>} app  @param {string[]} scenes
 */
async function checkGroup(page, browser, app, scenes) {
  const last = scenes === GROUPS.at(-1);
  /** @type {string[]} */
  const shown = [];
  let hash = '#/';
  let loads = 0;
  const errorsHash = () => `#/t/${Object.values(app.rt.s.threads).find((t) => t.title === 'Index the shelf')?.id}`;
  const errors = errorsOf(page, () => hash === errorsHash());
  await play({
    origin: app.origin,
    speed: 0.3,
    log: () => {},
    view: async (h) => {
      // A changing query string loads the page again, as a person opening the conversation would.
      await page.goto(`${app.origin}/?v=${++loads}${h}`);
      // Only now: the scene before may log what it means to until the next page has loaded, such as a late 503.
      hash = h;
      await synced(page, app);
    },
    shot: async (name, { prepare } = {}) => {
      shown.push(name);
      if (!scenes.includes(name)) return;
      await test.step(name, () => checkScene(browser, app, name, hash, prepare));
      if (!last && name === scenes.at(-1)) throw ENOUGH;
    },
  }).catch((e) => {
    if (e !== ENOUGH) throw e;
  });
  expect.soft(errors, 'the page that checks the apps threw no exceptions and logged no errors').toEqual([]);
  expect(shown, 'the demo showed every scene of the group').toEqual(expect.arrayContaining(scenes));
  // The last group plays the whole demo, so it sees a scene no group has.
  if (last) expect(shown, 'every scene the demo shows is in a group').toEqual(GROUPS.flat());
}

// CI runs these in halves, on two runners (--shard=1/2 and 2/2, which split them in the order they’re declared): the
// first group with the third, and the second with the last, so each half has one of the two that play the most.
for (const scenes of [GROUPS[0], GROUPS[2], GROUPS[1], GROUPS[3]])
  test(`demo scenes ${scenes[0]} to ${scenes.at(-1)} have no axe violations, at 1280 and 375 px in dark and light`, async ({ page, browser }) => {
    // Up to 23 scenes played, and up to 7 checked in four variants each.
    test.setTimeout(10 * 60_000);
    // play() sets the mock agents’ pace for this worker’s process; the next test it runs gets its own back.
    const speed = process.env.POSTBOX_MOCK_SPEED;
    const app = await startPostbox('demo-a11y');
    try {
      await checkGroup(page, browser, app, scenes);
    } finally {
      if (speed === undefined) delete process.env.POSTBOX_MOCK_SPEED;
      else process.env.POSTBOX_MOCK_SPEED = speed;
      await app.stop();
    }
  });
