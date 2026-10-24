// A headless Chrome check of how Postbox’s controls and states look, in both themes, at 375 and 1280 px:
//   - #181: a selected segment, a chosen chip and a toggle that’s on are an amber outline, never a solid amber fill
//     bigger than a glyph: in Postbox, in Settings, and in an app’s kit (intent.md, Visual language).
//   - #8: an overview card that needs you has a look of its own, a heavier amber top edge and a tinted head band,
//     not the 1 px amber outline of a button.
//   - #199: nothing with a border that wraps to a second line has fully rounded (pill) ends.
//   - #116: the composer in a topic thread and in a side thread is as tall as the conversation’s, and sits as high.
//
//   node tools/checks/look.mjs            (ONLY=#8 runs the cases whose name has that in it)
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (5400 and 10700 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(5400, 10700);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-look-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

/** Opens a route afresh: a new document, even when only the hash differs from the one open. */
async function open(hash) {
  await page.goto('about:blank');
  await page.goto(`${app.origin}/${hash}`);
  await page.synced(store.state.seq);
}
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 45 s')), 45000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}
/** Evaluates an expression in the page, or in a sandboxed app’s frame (its own process) when session is set. */
async function inside(session, expr) {
  if (!session) return page.evaluate(expr);
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error(`In the app: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
/** The CDP session of the app frame the selector finds. */
async function frameOf(selector) {
  const { result } = await page.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  assert.ok(result.objectId, `No frame: ${selector}`);
  const { node } = await page.send('DOM.describeNode', { objectId: result.objectId });
  const session = page.frameSession(node.frameId);
  assert.ok(session, `The frame ${selector} has no session of its own to read it through`);
  return session;
}

const persona = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
const project = Object.values(store.state.projects)[0];
const t = rt.createThread({ projectId: project.id, title: 'Look checks', personaIds: [persona('librarian').id] });
const se = rt.sessionsIn(t.id)[0];
const tools = rt.toolsFor(se.id);

// ── #181: selected and on states are amber outlines ─────────────────────────────────────

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

// Every element of a control (a button, a radio, a switch, a checkbox) bigger than a glyph whose background is
// amber; and, for each selected or on control, the colors that mark it.
const amberIn = (sel = 'body') => `(() => {
  const root = document.querySelector(${JSON.stringify(sel)});
  const probe = (v) => { const p = document.createElement('span'); p.style.background = v; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; };
  const accent = probe('var(--accent)');
  const amber = new Set([accent, probe('var(--on)')]);
  const solid = [];
  for (const c of root.querySelectorAll('button, [role=radio], [role=switch], [role=checkbox], [aria-pressed], [aria-checked]'))
    for (const n of [c, ...c.querySelectorAll('*')]) {
      const r = n.getBoundingClientRect();
      if (Math.min(r.width, r.height) > 18 && amber.has(getComputedStyle(n).backgroundColor))
        solid.push(n.tagName.toLowerCase() + '.' + [...n.classList].join('.') + ' “' + c.textContent.trim().slice(0, 30) + '” ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  const on = [...root.querySelectorAll('.seg button[aria-checked=true], .chip[aria-checked=true], .chip[aria-pressed=true], .toggle[aria-checked=true] .track')].map((n) => {
    const s = getComputedStyle(n);
    const edge = s.borderTopColor === accent || s.boxShadow.includes(accent);
    return { what: n.closest('.seg, .chip, .toggle').classList[0], text: s.color, edge, knob: getComputedStyle(n, '::after').backgroundColor };
  });
  return { solid, on, accent };
})()`;
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

for (const theme of ['dark', 'light'])
  for (const width of [1280, 375])
    await check(
      `#181 at ${width} px (${theme}): selected segments, chosen chips and on toggles are amber outlines, in Postbox, Settings and an app`,
      async () => {
        await page.size(width, 900, { theme });
        await open(`#/t/${t.id}`);
        await page.waitFor(
          `document.querySelector('.toggle[aria-checked=true]') && document.querySelector('.chips .chip') && document.querySelector('.appframe iframe')`,
        );
        await page.evaluate(`[...document.querySelectorAll('.chips .chip')].at(-1).click()`);
        await settle();
        const bad = unmarked(await page.evaluate(amberIn()), 'the conversation', ['toggle', 'chip']);
        const frame = await frameOf('.appframe iframe');
        for (let i = 0; i < 50 && !(await inside(frame, `!!document.querySelector('.seg')`)); i++) await settle();
        bad.push(...unmarked(await inside(frame, amberIn()), 'the app', ['seg']));
        await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings())`);
        await page.waitFor(`document.querySelector('.dialog .seg button[aria-checked=true]')`);
        bad.push(...unmarked(await page.evaluate(amberIn('.dialog')), 'Settings', ['seg']));
        assert.deepEqual(bad, []);
      },
    );

// ── #8: needs you is a state, with a look of its own ────────────────────────────────────

// A card that needs you, one that’s working, and a button with the interaction amber outline, side by side.
const CARDS = `(() => {
  const card = (sel) => { const n = document.querySelector(sel); if (!n) return null; const s = getComputedStyle(n); const head = getComputedStyle(n.querySelector('.oc-head'));
    return { top: s.borderTopWidth, topColor: s.borderTopColor, side: s.borderRightColor, sideWidth: s.borderRightWidth, head: head.backgroundColor }; };
  const probe = (v) => { const p = document.createElement('span'); p.style.background = v; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; };
  return { needs: card('.ov-col.needs'), working: card('.ov-col:not(.needs)'), accent: probe('var(--accent)'), band: probe('var(--needs-band)') };
})()`;
const worker = rt.sessionsIn(rt.createThread({ projectId: project.id, title: 'Working', personaIds: [persona('researcher').id] }).id)[0];
for (const theme of ['dark', 'light'])
  for (const width of [1280, 375])
    await check(
      `#8 at ${width} px (${theme}): a card that needs you has a heavier amber top edge and a tinted head, not a button’s amber outline`,
      async () => {
        rt.updateSession(se.id, { state: 'needs', needs: { kind: 'block', text: 'Which mode should the search use?' } });
        rt.updateSession(worker.id, { state: 'tool', startedAt: Date.now() });
        await page.size(width, 900, { theme });
        await open('#/');
        await page.waitFor(`document.querySelector('.ov-col.needs') && document.querySelector('.ov-col:not(.needs)')`);
        const m = await page.evaluate(CARDS);
        assert.ok(parseFloat(m.needs.top) >= 3 && m.needs.topColor === m.accent, `its top edge is ${m.needs.top} in ${m.needs.topColor}`);
        assert.ok(m.needs.side !== m.accent, 'its sides are the amber outline a button has');
        assert.equal(m.needs.side, m.working.side, 'its sides aren’t the card edge every card has');
        assert.ok(m.band !== 'rgba(0, 0, 0, 0)' && m.needs.head === m.band, `its head is ${m.needs.head}, not the needs-you band (${m.band})`);
        assert.notEqual(m.working.head, m.band, 'a working card has the needs-you band too');
      },
    );

// ── #199: a box that wraps isn’t a pill ─────────────────────────────────────────────────

// Every bordered element in the conversation that holds more than one line of text and is rounded to a pill.
const PILLS = `[...document.querySelectorAll('#main *')].flatMap((n) => {
  const s = getComputedStyle(n);
  if (s.borderTopStyle === 'none' || parseFloat(s.borderTopWidth) === 0 || !n.offsetHeight) return [];
  const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
  // scrollHeight: a box held to one line’s height that wraps anyway spills its second line out of it.
  const lines = (Math.max(n.clientHeight, n.scrollHeight) - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / line;
  return lines >= 1.8 && parseFloat(s.borderTopLeftRadius) >= n.offsetHeight / 2 ? [n.className + ' (' + n.offsetHeight + ' px tall): ' + n.textContent.slice(0, 40)] : [];
})`;
rt.addItem(t.id, {
  kind: 'voice',
  text: 'Sent: form · What should happen to the visual-explainer walkthrough from my last turn? Retire it (I’ll replace it with a one-line note)',
});
// System lines are pills on one line, and wrap at a narrow width.
rt.addItem(t.id, { kind: 'system', variant: 'compaction', handle: 'librarian', n: 2, kept: 41000, total: 182000, summary: 'Kept the index plan.' });
for (const width of [1280, 375])
  await check(`#199 at ${width} px: a line in your voice or a system line that wraps has a card’s corners, not pill ends`, async () => {
    await page.size(width, 900, { theme: 'dark' });
    await open(`#/t/${t.id}`);
    await page.waitFor(`document.querySelector('.voice')`);
    const lines = await page.evaluate(
      `(() => { const v = document.querySelector('.voice'); return Math.round(v.getBoundingClientRect().height / parseFloat(getComputedStyle(v).lineHeight)); })()`,
    );
    assert.ok(lines >= 2, `the line in your voice doesn’t wrap at ${width} px, so this checks nothing`);
    if (width < 768) {
      const pill = await page.evaluate(
        `(() => { const p = document.querySelector('#main .sys .pill'); return p.scrollHeight / parseFloat(getComputedStyle(p).lineHeight); })()`,
      );
      assert.ok(pill >= 1.8, `the compaction line doesn’t wrap at ${width} px, so this checks nothing`);
    }
    assert.deepEqual(await page.evaluate(PILLS), []);
  });

// ── #116: every composer lines up with the conversation’s ───────────────────────────────

const room = rt.createThread({ projectId: project.id, title: 'Composer heights', personaIds: [persona('researcher').id, persona('critic').id] });
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
// The last speaker makes the conversation’s hint two lines (“Replying to @researcher”).
rt.putThread({ ...store.state.threads[room.id], lastSpeaker: researcher.id });
const topic = rt.startTopic(room.id, root.id).threadId;
// A side thread as agentWake makes one (server/side-threads.mjs), without starting a turn.
const side = rt.putThread({
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
const BOXES = `[...document.querySelectorAll('.composer-box')].map((b) => { const r = b.getBoundingClientRect(); return { where: b.closest('.sidepanel') ? 'panel' : 'conversation', top: r.top, height: r.height }; })`;
for (const width of [1280, 375])
  await check(`#116 at ${width} px: the composers of a topic thread and a side thread are as tall as the conversation’s and sit as high`, async () => {
    await page.size(width, 900, { theme: 'dark' });
    const seen = [];
    for (const panel of [topic, side.id]) {
      await open(`#/t/${room.id}/side/${panel}`);
      await page.waitFor(`document.querySelectorAll('.composer-box').length === 2`);
      await settle();
      const [main, other] = await page.evaluate(BOXES);
      assert.equal(other.where, 'panel');
      seen.push(other);
      assert.ok(
        Math.abs(other.height - main.height) < 1,
        `the ${store.state.threads[panel].kind} thread’s box is ${other.height} px tall, the conversation’s ${main.height}`,
      );
      assert.ok(
        Math.abs(other.top - main.top) < 1,
        `the ${store.state.threads[panel].kind} thread’s box starts at ${other.top} px, the conversation’s at ${main.top}`,
      );
    }
    assert.ok(Math.abs(seen[0].top - seen[1].top) < 1, `the topic thread’s box starts at ${seen[0].top} px, the side thread’s at ${seen[1].top}`);
  });

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
finish();
