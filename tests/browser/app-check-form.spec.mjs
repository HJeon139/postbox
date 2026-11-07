// The pre-display check measures a picture’s form (#889), from the page’s geometry, at 375 and 1280 px:
// - text-in-shapes: a diagram of labeled boxes, most of its words inside rects and two boxes holding a sentence each.
// - ranks-one-number: marks that vary along one axis only, as bars from one baseline (in SVG, and as divs), and as a
//   lollipop sorted by its value.
// A scatter, which places each mark by two values, and a force-laid network, whose nodes sit where their links put
// them, get neither. Both are notes: the app is shown with notes, and the agent hears of them in its lint turn.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const svg = (w, h, label, body) =>
  `<!doctype html><html><body style="margin:0;padding:8px;color:var(--text)"><svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w * 1.5}px;height:auto;display:block" role="img" aria-label="${label}">${body}</svg></body></html>`;
const text = (x, y, s, anchor = 'start') => `<text x="${x}" y="${y}" font-size="14" fill="var(--text)" text-anchor="${anchor}">${s}</text>`;
// A seeded random number, so each fixture draws the same picture every run.
const seeded = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const STEPS = [
  'Read the papers',
  'Split them into chunks',
  'Embed every chunk with the small model',
  'Store the vectors in the local index',
  'Answer the question',
];
const boxes = svg(
  400,
  STEPS.length * 68,
  'How a question is answered',
  STEPS.map(
    (s, i) =>
      `<rect x="20" y="${i * 68 + 4}" width="360" height="44" rx="8" fill="var(--surface)" stroke="var(--line)"/>${text(200, i * 68 + 31, s, 'middle')}` +
      (i ? `<line x1="200" y1="${i * 68 - 20}" x2="200" y2="${i * 68 + 4}" stroke="var(--dim)" stroke-width="2"/>` : ''),
  ).join(''),
);

const DAYS = [
  ['Mon', 120],
  ['Tue', 60],
  ['Wed', 150],
  ['Thu', 90],
  ['Fri', 170],
  ['Sat', 40],
];
const bars = svg(
  400,
  240,
  'Messages a day',
  DAYS.map(([d, v], i) => `<rect x="${40 + i * 55}" y="${200 - v}" width="36" height="${v}" fill="var(--accent)"/>${text(58 + i * 55, 220, d, 'middle')}`).join(
    '',
  ),
);

const LANGS = [
  ['Rust', 0.92],
  ['Go', 0.81],
  ['Python', 0.66],
  ['Java', 0.52],
  ['Ruby', 0.38],
  ['Perl', 0.21],
];
const lollipop = svg(
  400,
  220,
  'Share of tests passing',
  LANGS.map(([l, v], i) => {
    const y = 30 + i * 32;
    const x = 120 + v * 250;
    return `${text(110, y + 5, l, 'end')}<line x1="120" y1="${y}" x2="${x}" y2="${y}" stroke="var(--dim)" stroke-width="2"/><circle cx="${x}" cy="${y}" r="6" fill="var(--accent)"/>`;
  }).join(''),
);

const rand = seeded(7);
const scatter = svg(
  400,
  300,
  'Hours of sleep against reaction time',
  Array.from({ length: 30 }, () => {
    const x = 40 + rand() * 330;
    const y = 260 - (x - 40) * 0.5 - rand() * 90;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="var(--accent)" fill-opacity="0.8"/>`;
  }).join('') +
    text(200, 290, 'Hours of sleep', 'middle') +
    text(10, 20, 'Reaction time'),
);

// Twelve people and who works with whom, laid out by a few hundred steps of a force simulation: links pull, nodes push.
const PEOPLE = ['Ana', 'Ben', 'Cai', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lu'];
const LINKS = [
  [0, 1],
  [1, 2],
  [2, 0],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 3],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 6],
  [8, 9],
  [9, 10],
  [10, 11],
  [11, 9],
  [1, 7],
];
function forceLaid() {
  const r = seeded(3);
  const p = PEOPLE.map(() => ({ x: r() * 300, y: r() * 300 }));
  for (let step = 0; step < 300; step++) {
    const f = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < p.length; i++)
      for (let j = 0; j < p.length; j++) {
        if (i === j) continue;
        const dx = p[i].x - p[j].x;
        const dy = p[i].y - p[j].y;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        f[i].x += (dx / d2) * 400;
        f[i].y += (dy / d2) * 400;
      }
    for (const [a, b] of LINKS) {
      const dx = p[b].x - p[a].x;
      const dy = p[b].y - p[a].y;
      [f[a].x, f[a].y, f[b].x, f[b].y] = [f[a].x + dx * 0.05, f[a].y + dy * 0.05, f[b].x - dx * 0.05, f[b].y - dy * 0.05];
    }
    for (const [i, q] of p.entries()) [q.x, q.y] = [q.x + Math.max(-5, Math.min(5, f[i].x)), q.y + Math.max(-5, Math.min(5, f[i].y))];
  }
  const [x0, x1, y0, y1] = [Math.min(...p.map((q) => q.x)), Math.max(...p.map((q) => q.x)), Math.min(...p.map((q) => q.y)), Math.max(...p.map((q) => q.y))];
  return p.map((q) => ({ x: 30 + ((q.x - x0) / (x1 - x0)) * 320, y: 30 + ((q.y - y0) / (y1 - y0)) * 240 }));
}
const at = forceLaid();
const network = svg(
  400,
  300,
  'Who works with whom',
  LINKS.map(([a, b]) => `<line x1="${at[a].x}" y1="${at[a].y}" x2="${at[b].x}" y2="${at[b].y}" stroke="var(--dim)" stroke-width="1.5"/>`).join('') +
    at.map((q, i) => `<circle cx="${q.x}" cy="${q.y}" r="7" fill="var(--accent)"/>${text(q.x + 10, q.y + 5, PEOPLE[i])}`).join(''),
);

// Bars drawn as divs, each as wide as its share.
const htmlBars = `<!doctype html><html><body style="margin:0;padding:8px;color:var(--text);font:14px system-ui,sans-serif">
<h3>Time to first reply</h3>
<div style="display:grid;grid-template-columns:80px 1fr;gap:8px 12px;align-items:center">
${DAYS.map(([d, v]) => `<span>${d}</span><div style="background:var(--line)"><div style="height:16px;width:${(v / 170) * 100}%;background:var(--accent)"></div></div>`).join('\n')}
</div></body></html>`;

const APPS = {
  boxes: { title: 'Answering a question', code: boxes, want: ['text-in-shapes'] },
  bars: { title: 'Messages a day', code: bars, want: ['ranks-one-number'] },
  lollipop: { title: 'Tests passing', code: lollipop, want: ['ranks-one-number'] },
  htmlBars: { title: 'First replies', code: htmlBars, want: ['ranks-one-number'] },
  scatter: { title: 'Sleep and reactions', code: scatter, want: [] },
  network: { title: 'Who works with whom', code: network, want: [] },
};
const FORM = ['text-in-shapes', 'ranks-one-number'];

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Every message Postbox sends the agent. */
const calls = [];
let thread;
test.beforeAll(async () => {
  app = await startPostbox('app-check-form');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(session, message, ctx) {
      calls.push(message);
      if (message.kind === 'user')
        for (const [id, a] of Object.entries(APPS)) ctx.tools.show_app({ id: `${id}-${session.threadId}`, title: a.title, code: a.code });
    },
  });
  const drawer = app.rt.createPersona({ handle: 'drawer' });
  thread = app.rt.createThread({ projectId: Object.values(app.rt.s.projects)[0].id, title: 'Forms', personaIds: [drawer.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#889 the check tells boxes and rankings apart from a scatter and a network, and the agent hears of them as notes', async ({ page }) => {
  test.setTimeout(60_000);
  const { rt } = app;
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  rt.sendMessage(thread.id, { text: 'draw them' });
  const st = (key) => rt.s.apps[`${key}-${thread.id}`]?.check ?? {};
  const problems = (key) => st(key).problems ?? [];
  await expect
    .poll(() => Object.keys(APPS).every((k) => st(k).status && st(k).status !== 'pending'), { message: 'the browser to check every app', timeout: 40_000 })
    .toBe(true);
  for (const [key, a] of Object.entries(APPS)) {
    const found = [...new Set(problems(key).map((p) => p.code))].filter((c) => FORM.includes(c));
    test.info().annotations.push({
      type: key,
      description:
        problems(key)
          .map((p) => `${p.code}: ${p.message}`)
          .join(' | ') || st(key).status,
    });
    expect.soft(found, `${key} gets ${a.want.join(' and ') || 'neither form note'}`).toEqual(a.want);
    for (const code of a.want) {
      const at = problems(key)
        .filter((p) => p.code === code)
        .map((p) => p.message.match(/^At (\d+) px/)?.[1]);
      expect.soft(at.sort(), `${key}’s ${code} is measured at both widths`).toEqual(['1280', '375']);
    }
  }
  expect.soft([st('boxes').status, st('boxes').notes], 'a box diagram is shown, with notes').toEqual(['note', true]);
  expect.soft([st('lollipop').status, st('lollipop').notes], 'a lollipop is shown, with notes').toEqual(['note', true]);
  const message = (key, code) => problems(key).find((p) => p.code === code)?.message ?? '';
  expect
    .soft(message('lollipop', 'ranks-one-number'), 'says what happened and what to do next')
    .toMatch(/vary on one axis only, so this ranks one number\. If the idea is how two things relate, place each mark by both/);
  expect
    .soft(message('boxes', 'text-in-shapes'), 'counts the words in boxes and the boxes holding a sentence')
    .toMatch(/\d+ of \d+ words \(\d+%\) sit inside 5 boxes, and 2 of them hold more than 6 words/);
  const told = () => new Set(calls.filter((m) => m.kind === 'lint').flatMap((m) => m.problems.map((p) => `${p.scope?.id} ${p.code}`)));
  await expect
    .poll(() => ['boxes text-in-shapes', 'lollipop ranks-one-number'].every((k) => told().has(k.replace(' ', `-${thread.id} `))), {
      message: 'the agent is told in its lint turn',
      timeout: 20_000,
    })
    .toBe(true);
  expect(calls.filter((m) => m.kind === 'app-check').length, 'and isn’t sent back to fix them').toBe(0);
  // The bars, the div bars and the lollipop.
  const ranked = page.locator('.app-note', { hasText: /ranks one number/ });
  await expect(ranked, 'the person sees each ranking with a note').toHaveCount(3);
  for (const note of await ranked.allTextContents()) expect.soft(note, 'shown with notes, not as a failure').toMatch(/^Shown with notes for @drawer/);
});
