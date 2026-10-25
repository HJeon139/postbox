// A headless Chrome check of how the transcript renders what agents write, beside tools/check-transcript.mjs (which
// is at its length ceiling), driven with real mouse and keyboard input:
//   • a reply shared back from a topic thread draws its math and diagrams and links the thread’s glossary, as an
//     agent’s reply does (#99);
//   • a glossary term inside a definition opens a card of its own over its parent’s, by mouse and by keyboard;
//     leaving the child closes only the child, a cycle (U → U:13 → U) and a fourth level open nothing, and the cards
//     stay on screen at 375 px (#103);
//   • a later turn of the same agent gets its own sender line, with its time and what woke it (another agent, or a
//     scheduled wake), while one turn’s items share one; so does each wake it sent from a turn of its own, in a side
//     thread (#135).
//
//   node tools/check-transcript-render.mjs
//
// It runs its own Postbox, with the demo seed (mock agents) on a fresh data folder, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT: CHROME } = await ports(5060, 10260);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-transcript-render-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME });
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};

try {
  const { rt, store } = app;
  const project = Object.values(rt.s.projects)[0];
  const persona = rt.createPersona({ handle: 'analyst' });
  const thread = rt.createThread({ projectId: project.id, title: 'Render checks', personaIds: [persona.id] });
  const se = rt.sessionsIn(thread.id)[0];
  const tools = rt.toolsFor(se.id);
  const say = (text) => rt.addItem(thread.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  tools.define_term({ term: 'macro-F1', definition: 'The mean of the F1 score of each label, so a rare label counts as much as a common one.' });
  await page.size(1280, 900);

  // ── #99: a reply shared back from a topic thread ──
  // The formula is the one wave 2’s SciFact UAT saw as source in the conversation’s copy (#99).
  const { threadId: topic } = rt.startTopic(thread.id, say('The scores are in.').id);
  // A term defined in the topic thread, where the summary was written, and not in the conversation. The topic has no
  // session of its own (#228): the agent’s one session answers there, in a turn that speaks in the topic.
  rt.toolsFor(se.id, { threadId: topic }).define_term({ term: 'label weight', definition: 'How many of the 300 claims carry a label.' });
  const shared = rt.shareText(thread.id, {
    fromThreadId: topic,
    handle: 'analyst',
    summary: true,
    text: [
      'The macro-F1 over both labels, each by its label weight:',
      '',
      '$$',
      '(188 \\times 0.812 + 112 \\times 0.409)/300 = 0.661',
      '$$',
      '',
      '```mermaid',
      'flowchart LR',
      '  claims[Claims] --> abstracts[Abstracts]',
      '```',
    ].join('\n'),
  });
  // A reply that keeps its question (#111): one whose fence would have swallowed the answer, were they one text.
  const question = 'Which?\n```js\nconst unit = "page"';
  const answered = rt.shareText(thread.id, { fromThreadId: topic, handle: 'analyst', text: 'Use chapter offsets.', question });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await page.synced(store.state.seq);
  const ASKED = `document.querySelector('[data-key="${answered.id}"] .shared-card')`;
  await page.waitFor(ASKED, { label: 'the shared reply' });
  const parts = await page.evaluate(
    `(() => { const c = ${ASKED}; return { q: !!c.querySelector('.shared-q pre'), a: [...c.querySelectorAll('p')].some((p) => p.textContent === 'Use chapter offsets.' && !p.closest('pre, .shared-q')) }; })()`,
  );
  check(parts.q && parts.a, `#111 a shared reply shows its question apart, and the answer isn’t swallowed by it (${JSON.stringify(parts)})`);
  const CARD = `document.querySelector('[data-key="${shared.id}"] .shared-card')`;
  await page.waitFor(CARD, { label: 'the shared summary' });
  // KaTeX keeps the source in its MathML, so what’s read is whether every formula was drawn.
  const math = await until(() =>
    page.evaluate(`(() => { const m = [...${CARD}.querySelectorAll('.md-math')]; return m.length > 0 && m.every((x) => x.querySelector('.katex-html')); })()`),
  );
  check(math, 'a shared summary draws its math, not its source');
  const diagram = await until(() => page.evaluate(`!!${CARD}.querySelector('figure.diagram iframe')?.dataset.sized`));
  check(diagram, 'a shared summary draws its Mermaid diagram in a frame');
  const term = await page.evaluate(`${CARD}.querySelector('.term')?.dataset.term ?? ''`);
  check(term === 'macro-f1', `a shared summary links the conversation’s glossary (“${term}”)`);
  const TOPIC_TERM = `${CARD}.querySelector('.term[data-term="label-weight"]')`;
  const linked = await page.evaluate(`!!${TOPIC_TERM} && !${TOPIC_TERM}.classList.contains('undef')`);
  const at = await page.evaluate(
    `(() => { const r = ${TOPIC_TERM}?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : { x: 0, y: 0 }; })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none' });
  const card = await page.evaluate(`document.querySelector('.hovercard')?.getAttribute('aria-label') ?? ''`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1270, y: 890, button: 'none' });
  check(linked && card === 'Glossary: label weight', `and the glossary of the topic it was written in, with its card (“${card}”)`);

  // ── #103: nested glossary cards ──
  // The terms from #103’s report: U’s definition names U:13, and U:13’s names U back. alpha → beta → gamma → delta
  // is one level deeper than the cards go.
  const nested = rt.createThread({ projectId: project.id, title: 'Nested glossary', personaIds: [persona.id] });
  const ns = rt.sessionsIn(nested.id)[0];
  const define = rt.toolsFor(ns.id).define_term;
  define({ term: 'U', definition: 'The utility of a claim: U is the sum over its labels, such as U:13.' });
  define({ term: 'U:13', definition: 'The utility of label 13, one term of U.' });
  for (const [term, next] of [
    ['alpha', 'beta'],
    ['beta', 'gamma'],
    ['gamma', 'delta'],
  ])
    define({ term, definition: `Leads on to ${next}.` });
  define({ term: 'delta', definition: 'The last one.' });
  rt.addItem(nested.id, { kind: 'agent', sessionId: ns.id, personaId: ns.personaId, handle: ns.handle, text: 'Rank by U. Start at alpha.', status: 'done' });
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${nested.id}'`);
  await page.waitFor(`document.querySelector('.transcript[data-thread="${nested.id}"] .term')`, { label: 'the nested glossary thread' });

  const HC = (term) => `[...document.querySelectorAll('.hovercard')].find((c) => c.getAttribute('aria-label') === 'Glossary: ${term}')`;
  const TERM = (scope, key) => `${scope}?.querySelector('.term[data-term="${key}"]')`;
  const REPLY = `document.querySelector('.transcript[data-thread="${nested.id}"] .turn .md')`;
  const open = () => page.evaluate(`[...document.querySelectorAll('.hovercard')].map((c) => c.getAttribute('aria-label').replace('Glossary: ', ''))`);
  const moveTo = async (expr) => {
    const p = await page.evaluate(`(() => { const r = ${expr}?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    assert.ok(p, `Nothing to point at: ${expr}`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  };
  const press = async (key, code, keyCode) => {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const pinned = (term) => page.waitFor(`${HC(term)}?.classList.contains('pinned')`, { label: `the card for ${term}, pinned` });
  const pinU = () => page.evaluate(`${TERM(REPLY, 'u')}.focus()`).then(() => press('Enter', 'Enter', 13).then(() => pinned('U')));
  /** Hovers a term inside the card for `from` (or the reply) and waits for its own card to pin. */
  const hover = async (from, term, k = term.toLowerCase()) => {
    await moveTo(TERM(from ? HC(from) : REPLY, k));
    await pinned(term);
  };
  const scenario = async (name, fn) => {
    try {
      await fn();
      check(true, name);
    } catch (e) {
      check(false, name, e.message);
    }
    // Every card closed before the next: the pointer away, and Escape for any that stay.
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1270, y: 890, button: 'none' });
    for (let i = 0; i < 4 && (await open()).length; i++) await press('Escape', 'Escape', 27);
    await page.waitFor(`!document.querySelector('.hovercard')`, { label: 'every card to close' });
  };

  await scenario('#103 hovering U, then U:13 in its card, shows both; leaving U:13 for U’s card closes only U:13', async () => {
    await hover(null, 'U');
    assert.ok(!(await page.evaluate(`!!${TERM(HC('U'), 'u')}`)), 'U’s definition doesn’t link U itself');
    await hover('U', 'U:13', 'u-13');
    assert.deepEqual(await open(), ['U', 'U:13']);
    await moveTo(`${HC('U:13')}.querySelector('.hc-head')`);
    await moveTo(`${HC('U')}.querySelector('.hc-head')`);
    await page.waitFor(`!${HC('U:13')}`, { label: 'U:13’s card to close' });
    await sleep(900);
    assert.deepEqual(await open(), ['U'], 'U’s card stays');
  });

  await scenario('#103 a cycle opens no more cards: U inside U:13’s card, under U’s', async () => {
    await hover(null, 'U');
    await hover('U', 'U:13', 'u-13');
    await moveTo(TERM(HC('U:13'), 'u'));
    await sleep(1200);
    assert.deepEqual(await open(), ['U', 'U:13']);
  });

  await scenario('#103 cards go three deep: delta inside gamma’s card opens nothing', async () => {
    await hover(null, 'alpha');
    await hover('alpha', 'beta');
    await hover('beta', 'gamma');
    await moveTo(TERM(HC('gamma'), 'delta'));
    await sleep(1200);
    assert.deepEqual(await open(), ['alpha', 'beta', 'gamma']);
  });

  await scenario('#103 by keyboard: Enter pins and moves into the card, Tab reaches U:13, Escape closes one card at a time', async () => {
    const at = () =>
      page.evaluate(
        `(() => { const a = document.activeElement; return (a.closest('.hovercard')?.getAttribute('aria-label') ?? 'page') + ' ' + (a.dataset.term ?? a.className); })()`,
      );
    await pinU();
    assert.equal(await at(), 'Glossary: U hovercard pinned', 'Enter pins U’s card and moves into it');
    await press('Tab', 'Tab', 9);
    assert.equal(await at(), 'Glossary: U u-13', 'Tab reaches U:13');
    await press(' ', 'Space', 32);
    await pinned('U:13');
    assert.deepEqual(await open(), ['U', 'U:13'], 'Space pins U:13’s card over U’s');
    await press('Escape', 'Escape', 27);
    assert.deepEqual(await open(), ['U'], 'Escape closes the top card');
    assert.equal(await at(), 'Glossary: U u-13', 'and focus returns to its term');
    await press('Escape', 'Escape', 27);
    assert.deepEqual(await open(), []);
    assert.equal(await at(), 'page u', 'focus returns to U in the reply');
  });

  await scenario('#103 a card that closes while it has focus, as the pointer opens another, gives focus back to its term', async () => {
    await pinU();
    await hover(null, 'alpha');
    assert.deepEqual(await open(), ['alpha'], 'the pointer’s card replaces U’s');
    assert.ok(await page.evaluate(`document.activeElement === ${TERM(REPLY, 'u')}`), 'focus is back on U in the reply');
  });

  await page.size(375, 812);
  await scenario('#103 at 375 px, both cards stay on screen, and nothing scrolls sideways', async () => {
    // Opened by keyboard, which pins at once: pointing needs 650 ms of a still pointer, and under load timed out (#271).
    await pinU();
    await press('Tab', 'Tab', 9);
    await press(' ', 'Space', 32);
    await pinned('U:13');
    const box = await page.evaluate(
      `[...document.querySelectorAll('.hovercard')].map((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })`,
    );
    assert.deepEqual(box, [true, true], 'each card inside the window');
    assert.ok(await page.evaluate('document.scrollingElement.scrollWidth <= innerWidth'), 'no sideways scroll');
  });
  await page.size(1280, 900);

  // ── #135: a later turn of the same agent gets its own sender line ──
  // The mixed-room UAT run (22 October 2026), step 6: @critic replied, then spoke again in a new turn after @researcher
  // answered it in their side thread, and the second message showed with no sender line. Here @analyst wakes
  // @reviewer, which answers in the side thread, and a second answer comes back as endTurn sends one (saidIn).
  const room = rt.createThread({ projectId: project.id, title: 'Turn checks', personaIds: [persona.id, rt.createPersona({ handle: 'reviewer' }).id] });
  const an = rt.sessionsIn(room.id).find((x) => x.handle === 'analyst');
  const idle = () => until(() => !rt.turns.size && !rt.exiting.size, 20000);
  rt.agentWake(an.id, 'reviewer', 'Check revision 3.');
  await idle();
  const side = Object.values(rt.s.threads).find((x) => x.kind === 'side' && x.parentId === room.id);
  rt.deliver(an.id, { kind: 'agent', from: '@reviewer', text: 'Revision 3 has one arithmetic gap.', saidIn: side.id });
  await idle();
  // One turn of two items, as a reply split by a block is: they keep one sender line.
  for (const text of ['Part one.', 'Part two.'])
    rt.addItem(room.id, { kind: 'agent', sessionId: an.id, personaId: an.personaId, handle: 'analyst', turnId: 'turn_135', text, status: 'done' });
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${room.id}'`);
  await page.waitFor(`document.querySelectorAll('.transcript[data-thread="${room.id}"] > .item').length >= 4`, { label: 'the turn checks room' });
  const lines = await page.evaluate(
    `[...document.querySelectorAll('.transcript[data-thread="${room.id}"] > .item')].filter((n) => n.querySelector('.md p')).map((n) => { const w = n.querySelector('.who'); return w ? w.innerText.replace(/\\s+/g, ' ').trim() + (w.querySelector('.ts') ? ' [time]' : '') : ''; })`,
  );
  const [, second, one, two] = lines.slice(-4);
  check(
    /^@analyst.*after @reviewer replied in a side thread.*\[time\]$/.test(second ?? ''),
    `#135 the next turn of the same agent has its own sender line, its time and what woke it (“${second}”)`,
  );
  check(/^@analyst.*\[time\]$/.test(one ?? '') && two === '', `#135 one turn’s two items share one sender line (“${one}”, “${two}”)`);

  // A turn a scheduled wake started says so, as the timer delivers it ({ kind: 'wake', note }, server/adapters/adapter.mjs).
  const replies = () => store.items(room.id).filter((x) => x.kind === 'agent' && x.handle === 'analyst').length;
  const had = replies();
  rt.schedule(an.id, { inMs: 1000, note: 'Look at the totals again.' });
  await until(() => replies() > had, 5000);
  await idle();
  await page.synced(store.state.seq);
  const whoOf = (id) =>
    `[...document.querySelectorAll('.transcript[data-thread="${id}"] > .item')].filter((n) => n.querySelector('.md p')).map((n) => n.querySelector('.who')?.innerText.replace(/\\s+/g, ' ').trim() ?? '')`;
  const woken = (await page.evaluate(whoOf(room.id))).at(-1);
  check(/^@analyst.*woken by a scheduled wake/.test(woken ?? ''), `#135 a turn a scheduled wake started says so on its sender line (“${woken}”)`);
  // Two wakes from two turns of @analyst, sent while @reviewer was busy, sit together in the side thread, as agentWake
  // records them: each says the turn it came from. A third from the second turn shares its line.
  for (const [n, text] of ['Check the totals.', 'And the dates, please.', 'And the names.'].entries())
    rt.addItem(side.id, {
      kind: 'agent',
      sessionId: an.id,
      personaId: an.personaId,
      handle: 'analyst',
      text,
      status: 'done',
      hop: n + 1,
      fromTurnId: `turn_135_${Math.min(n, 1)}`,
    });
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${room.id}/side/${side.id}'`);
  await page.waitFor(`[...document.querySelectorAll('.transcript[data-thread="${side.id}"] .md p')].some((p) => p.textContent === 'And the names.')`, {
    label: 'the side thread',
  });
  const wakes = (await page.evaluate(whoOf(side.id))).slice(-3);
  check(
    /^@analyst/.test(wakes[0]) && /^@analyst/.test(wakes[1]) && wakes[2] === '',
    `#135 two wakes from two turns of the same agent each have a sender line in the side thread, and one turn’s two share it (${JSON.stringify(wakes)})`,
  );

  check(!page.logs.length, `no errors in the page${page.logs.length ? `: ${page.logs.join('; ')}` : ''}`);
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

finish();
