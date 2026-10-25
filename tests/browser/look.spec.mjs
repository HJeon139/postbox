// How Postbox’s controls and states look, in the dark theme, at 375 and 1280 px:
// - #181: a selected segment, a chosen chip and a toggle that’s on are an amber outline, never a solid fill bigger than
//   a glyph: in Postbox, in Settings, and in an app’s kit (intent.md, Visual language);
// - #199: nothing with a border that wraps to a second line has fully rounded (pill) ends;
// - #116: the composer in a topic thread and in a side thread is as tall as the conversation’s, and sits as high;
// - #182: every text button has the --line-strong border or the one inline-action style, an underline in
//   --line-strong; only an icon button may be bare.
// Moved from tools/checks/look.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** The conversation with @librarian’s blocks, the room with its topic and side threads, and the topic in the first. */
let t;
let se;
let room;
let topic;
let side;
let asked;

/** The conversation with @librarian’s blocks, apps and lines, and a topic thread from its reply. */
function conversation() {
  const { rt, store } = app;
  const persona = (handle) => rt.personaByHandle(handle);
  const project = Object.values(store.state.projects)[0];
  t = rt.createThread({ projectId: project.id, title: 'Look checks', personaIds: [persona('librarian').id] });
  se = rt.sessionsIn(t.id)[0];
  const tools = rt.toolsFor(se.id);
  // #181: a toggle that’s on, chips to choose, and an app with a selected segment of the kit.
  tools.show_block({
    block: {
      id: 'prefs',
      type: 'form',
      version: 1,
      title: 'Index settings',
      fallback: 'Index settings',
      fields: [{ id: 'stem', label: 'Stem words', kind: 'toggle', default: true }],
    },
  });
  tools.show_block({
    block: {
      id: 'mode',
      type: 'choice',
      version: 1,
      title: 'Search mode',
      fallback: 'Search mode',
      options: ['Lexical', 'Semantic', 'Both'].map((l) => ({ id: l.toLowerCase(), label: l })),
    },
  });
  tools.show_app({
    id: 'kitseg',
    title: 'Corpus explorer',
    code: '<main style="padding:12px"><span class="seg" role="radiogroup" aria-label="Mode"><button role="radio" aria-checked="false">Lexical</button><button role="radio" aria-checked="true">Both</button></span></main>',
    permissions: [],
  });
  // #199: a line in your voice that wraps, and a system line, a pill on one line, that wraps at a narrow width.
  rt.addItem(t.id, {
    kind: 'voice',
    text: 'Sent: form · What should happen to the visual-explainer walkthrough from my last turn? Retire it (I’ll replace it with a one-line note)',
  });
  rt.addItem(t.id, { kind: 'system', variant: 'compaction', handle: 'librarian', n: 2, kept: 41000, total: 182000, summary: 'Kept the index plan.' });
  // #182: a table with a row action, and a topic thread from a reply.
  tools.show_block({
    block: {
      id: 'hits',
      type: 'table',
      version: 1,
      title: 'Passages',
      fallback: 'Passages',
      columns: [
        { id: 'book', label: 'Book' },
        { id: 'hits', label: 'Hits', kind: 'number' },
      ],
      rows: [
        { id: 'r1', cells: { book: 'Middlemarch', hits: 12 } },
        { id: 'r2', cells: { book: 'Emma', hits: 4 } },
      ],
      rowAction: { id: 'open', label: 'Open' },
    },
  });
  const said = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'I found 16 passages.', status: 'done' });
  asked = rt.startTopic(t.id, said.id).threadId;
}

/** The room with a long conversation, a two-line hint, a topic thread and a side thread. */
function composerRoom() {
  const { rt, store } = app;
  const persona = (handle) => rt.personaByHandle(handle);
  const project = Object.values(store.state.projects)[0];
  // #116: a room whose conversation hint is two lines (“Replying to @researcher”), a topic thread and a side thread.
  room = rt.createThread({ projectId: project.id, title: 'Composer heights', personaIds: [persona('researcher').id, persona('critic').id] });
  const [researcher, critic] = rt.sessionsIn(room.id);
  for (let i = 1; i <= 30; i++) rt.addItem(room.id, { kind: 'user', text: `Question ${i}: what does the observation step add?` });
  const root = rt.addItem(room.id, {
    kind: 'agent',
    sessionId: researcher.id,
    personaId: researcher.personaId,
    handle: researcher.handle,
    text: 'The observation grounds the plan.',
    status: 'done',
  });
  rt.putThread({ ...store.state.threads[room.id], lastSpeaker: researcher.id });
  topic = rt.startTopic(room.id, root.id).threadId;
  // A side thread as agentWake makes one (server/side-threads.mjs), without starting a turn.
  side = rt.putThread({
    ...{ id: 'th_lookside', projectId: project.id, title: '@critic ↔ @researcher', kind: 'side', parentId: room.id, pair: 'critic|researcher' },
    ...{ woke: 'researcher', members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now(), archived: false },
  });
  rt.addItem(side.id, {
    kind: 'agent',
    sessionId: critic.id,
    personaId: critic.personaId,
    handle: critic.handle,
    text: 'Can you check the schema?',
    status: 'done',
  });
}

test.beforeAll(async () => {
  app = await startPostbox('look');
  conversation();
  composerRoom();
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'dark' });

async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
}

/**
 * In the page or an app’s frame: every element of a control (a button, a radio, a switch, a checkbox) bigger than a
 * glyph whose background is amber; and, for each selected or on control, the colors that mark it.
 */
const amberIn = (sel) => {
  const root = /** @type {Element} */ (document.querySelector(sel));
  const probe = (v) => {
    const p = document.createElement('span');
    p.style.background = v;
    document.body.append(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  };
  const accent = probe('var(--accent)');
  const amber = new Set([accent, probe('var(--on)')]);
  const solid = [];
  for (const c of root.querySelectorAll('button, [role=radio], [role=switch], [role=checkbox], [aria-pressed], [aria-checked]'))
    for (const n of [c, ...c.querySelectorAll('*')]) {
      const r = n.getBoundingClientRect();
      if (Math.min(r.width, r.height) > 18 && amber.has(getComputedStyle(n).backgroundColor))
        solid.push(
          `${n.tagName.toLowerCase()}.${[...n.classList].join('.')} “${c.textContent?.trim().slice(0, 30)}” ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
    }
  const on = [
    ...root.querySelectorAll('.seg button[aria-checked=true], .chip[aria-checked=true], .chip[aria-pressed=true], .toggle[aria-checked=true] .track'),
  ].map((n) => {
    const s = getComputedStyle(n);
    return {
      what: n.closest('.seg, .chip, .toggle')?.classList[0],
      text: s.color,
      edge: s.borderTopColor === accent || s.boxShadow.includes(accent),
      knob: getComputedStyle(n, '::after').backgroundColor,
    };
  });
  return { solid, on, accent };
};
/** What’s wrong with how a place marks its selected and on states: an amber fill, or a state not marked in amber. */
function unmarked(found, where, kinds) {
  const bad = found.solid.map((s) => `${where}: a solid amber fill on ${s}`);
  for (const k of kinds) if (!found.on.some((o) => o.what === k)) bad.push(`${where}: no selected ${k} to look at`);
  for (const o of found.on) {
    if (!o.edge) bad.push(`${where}: a selected ${o.what} has no amber edge`);
    if ((o.what === 'toggle' ? o.knob : o.text) !== found.accent) bad.push(`${where}: a selected ${o.what} isn’t marked in amber (${o.text}, knob ${o.knob})`);
  }
  return bad;
}

/** #181 at each width (dark): selected segments, chosen chips and on toggles are amber outlines, in Postbox, Settings and an app */
async function amberOutlines(page) {
  await open(page, `#/t/${t.id}`);
  await expect(page.locator('.toggle[aria-checked=true]')).toBeVisible();
  await page.locator('.chips .chip').last().click();
  await expect(page.locator('.chips .chip').last()).toHaveAttribute('aria-checked', 'true');
  await settled(page);
  const bad = unmarked(await page.evaluate(amberIn, 'body'), 'the conversation', ['toggle', 'chip']);
  // The app runs in a frame of its own, in its own process.
  const handle = await page.locator('.appframe iframe.app-iframe').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('The app’s frame has no document to read');
  await expect(frame.locator('.seg')).toBeVisible();
  bad.push(...unmarked(await frame.evaluate(amberIn, 'body'), 'the app', ['seg']));
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.dialog .seg button[aria-checked=true]').first()).toBeVisible();
  bad.push(...unmarked(await page.evaluate(amberIn, '.dialog'), 'Settings', ['seg']));
  expect(bad).toEqual([]);
}

/** #199 at each width: a line in your voice or a system line that wraps has a card’s corners, not pill ends */
async function noWrappedPills(page, width) {
  await open(page, `#/t/${t.id}`);
  await expect(page.locator('.voice')).toBeVisible();
  await settled(page);
  const lines = await page.locator('.voice').evaluate((v) => Math.round(v.getBoundingClientRect().height / parseFloat(getComputedStyle(v).lineHeight)));
  expect(lines, `the line in your voice wraps at ${width} px, or this checks nothing`).toBeGreaterThanOrEqual(2);
  if (width < 768) {
    const pill = await page.locator('#main .sys .pill').evaluate((p) => p.scrollHeight / parseFloat(getComputedStyle(p).lineHeight));
    expect(pill, `the compaction line wraps at ${width} px, or this checks nothing`).toBeGreaterThanOrEqual(1.8);
  }
  // Every bordered element in the conversation that holds more than one line of text and is rounded to a pill.
  const pills = await page.evaluate(() =>
    [...document.querySelectorAll('#main *')].flatMap((n) => {
      const s = getComputedStyle(n);
      const box = /** @type {HTMLElement} */ (n);
      if (s.borderTopStyle === 'none' || parseFloat(s.borderTopWidth) === 0 || !box.offsetHeight) return [];
      const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
      // scrollHeight: a box held to one line’s height that wraps anyway spills its second line out of it.
      const lines = (Math.max(n.clientHeight, n.scrollHeight) - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / line;
      return lines >= 1.8 && parseFloat(s.borderTopLeftRadius) >= box.offsetHeight / 2
        ? [`${n.className} (${box.offsetHeight} px tall): ${n.textContent?.slice(0, 40)}`]
        : [];
    }),
  );
  expect(pills).toEqual([]);
}

/** #116 at each width: the composers of a topic thread and a side thread are as tall as the conversation’s and sit as high */
async function composersLineUp(page) {
  const seen = [];
  for (const panel of [topic, side.id]) {
    await open(page, `#/t/${room.id}/side/${panel}`);
    await expect(page.locator('.composer-box')).toHaveCount(2);
    await settled(page);
    const [main, other] = await page.locator('.composer-box').evaluateAll((bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect();
        return { where: b.closest('.sidepanel') ? 'panel' : 'conversation', top: r.top, height: r.height };
      }),
    );
    expect(other.where).toBe('panel');
    seen.push(other);
    const kind = app.store.state.threads[panel].kind;
    expect(Math.abs(other.height - main.height), `the ${kind} thread’s box is ${other.height} px tall, the conversation’s ${main.height}`).toBeLessThan(1);
    expect(Math.abs(other.top - main.top), `the ${kind} thread’s box starts at ${other.top} px, the conversation’s at ${main.top}`).toBeLessThan(1);
  }
  expect(Math.abs(seen[0].top - seen[1].top), `the topic thread’s box starts at ${seen[0].top} px, the side thread’s at ${seen[1].top}`).toBeLessThan(1);
}

/** #182 at each width: every text button has a border or the inline-action underline, in a conversation and its thread panel */
async function buttonsLookLikeControls(page) {
  app.rt.updateSession(se.id, { state: 'needs', needs: { kind: 'block', text: 'Which mode should the search use?' } });
  await open(page, `#/t/${t.id}/side/${asked}`);
  await expect(page.locator('.tbl .btn').first()).toBeVisible();
  await expect(page.locator('.sidepanel .sp-head .btn').first()).toBeVisible();
  await settled(page);
  // Every .btn with words on it whose edge you can’t see and that isn’t underlined in --line-strong.
  const bare = await page.evaluate(() => {
    const p = document.createElement('span');
    p.style.color = 'var(--line-strong)';
    document.body.append(p);
    const strong = getComputedStyle(p).color;
    p.remove();
    const clear = (c) => c === 'transparent' || /rgba\(.*, 0\)$/.test(c);
    return [...document.querySelectorAll('.btn')]
      .filter((b) => b.getClientRects().length)
      .flatMap((b) => {
        const words = [...b.childNodes]
          .map((n) => (n.nodeType === 3 || !(/** @type {Element} */ (n).matches('.sr-only, [aria-hidden=true], svg, .i')) ? n.textContent : ''))
          .join('')
          .trim();
        if (!words) return [];
        const s = getComputedStyle(b);
        const edge = s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0 && !clear(s.borderTopColor);
        const inline = s.textDecorationLine.includes('underline') && s.textDecorationColor === strong;
        return edge || inline ? [] : [`conversation: “${words.slice(0, 30)}” (${b.className})`];
      });
  });
  // Two actions of the same weight, side by side, look the same.
  const head = await page
    .locator('.sidepanel .btn')
    .evaluateAll((bs) =>
      Object.fromEntries(
        bs.filter((b) => /^(Copy link|Summarize back)$/.test(b.textContent ?? '')).map((b) => [b.textContent, getComputedStyle(b).borderTopColor]),
      ),
    );
  expect(head['Copy link'] && head['Copy link'] === head['Summarize back'], `Copy link and Summarize back have the same edge: ${JSON.stringify(head)}`).toBe(
    true,
  );
  expect(bare).toEqual([]);
}

/** Each test, its name at a width, and what it runs. */
const CASES = [
  [(w) => `#181 at ${w} px (dark): selected segments, chosen chips and on toggles are amber outlines, in Postbox, Settings and an app`, amberOutlines],
  [(w) => `#199 at ${w} px: a line in your voice or a system line that wraps has a card’s corners, not pill ends`, noWrappedPills],
  [(w) => `#116 at ${w} px: the composers of a topic thread and a side thread are as tall as the conversation’s and sit as high`, composersLineUp],
  [(w) => `#182 at ${w} px: every text button has a border or the inline-action underline, in a conversation and its thread panel`, buttonsLookLikeControls],
];

for (const width of [1280, 375])
  test.describe(`${width} px`, () => {
    test.use(width < 768 ? { viewport: { width, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height: 900 } });
    for (const [name, run] of CASES) test(name(width), ({ page }) => run(page, width));
  });
