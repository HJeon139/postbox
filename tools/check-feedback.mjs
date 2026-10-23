// Headless checks for the checks that close the loop (M3): what the browser finds reaches the agent.
//   • #46: a diagram Mermaid can’t draw comes back to the agent as a lint turn, and the person still sees the
//     frame’s “couldn’t be drawn” text and Show source.
//   • #53: the app check measures marks, labels and dashes at 375 and 1280 px. A chart too small to read, and an
//     app that shows only an error, are shown with notes and reach the agent; a readable chart passes.
//   • #58: a progress step shows “2 of 4 papers” with a bar, the block says when it last moved, a running step’s
//     time goes up and its glyph turns (still with reduced motion), and a step left running looks stalled.
//
// SHOTS=dir also saves a screenshot of the progress block, running and stalled.
//
//   node tools/check-feedback.mjs
//
// It runs its own Postbox, with a fresh data folder and a scripted agent, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT: CHROME } = await ports(4610, 9810);

const BROKEN = 'flowchart LR\n  A[Read] -->> B[Index]';

/** The agent: replies from a script, and records every message Postbox sends it. */
const calls = [];
// A chart of 900 dots, labels and dashed links, drawn far too small; the same chart at a readable size.
const chart = ({ n, r, font, dash, stroke, view }) => `<!doctype html><html><body style="margin:0">
<svg id="c" viewBox="0 0 ${view} ${view / 2}" style="width:100%;height:auto;display:block" role="img" aria-label="Pairs"></svg>
<script>
const svg = document.getElementById('c'); const ns = 'http://www.w3.org/2000/svg'; let out = '';
for (let i = 0; i < ${n}; i++) {
  const x = 20 + ((i * 37) % (${view} - 40)), y = 20 + ((i * 53) % (${view} / 2 - 40));
  out += '<circle cx="' + x + '" cy="' + y + '" r="${r}" fill="var(--accent)"/>';
  if (i % 3 === 0) out += '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 30) + '" y2="' + (y + 10) + '" stroke="var(--dim)" stroke-width="${stroke}" stroke-dasharray="${dash}"/>';
  if (i % 9 === 0) out += '<text x="' + x + '" y="' + (y - 4) + '" font-size="${font}" fill="var(--text)">p' + i + '</text>';
}
svg.innerHTML = out;
</script></body></html>`;
const APPS = {
  tiny: { title: 'Pair explorer', code: chart({ n: 900, r: 0.8, font: 9, dash: '2 1', stroke: 0.6, view: 2400 }) },
  readable: { title: 'Pair summary', code: chart({ n: 12, r: 8, font: 14, dash: '8 5', stroke: 2, view: 360 }) },
  missing: {
    title: 'SciFact explorer',
    code: '<!doctype html><html><body><p>SciFact isn’t loaded in this Postbox yet. Restart Postbox to load it.</p></body></html>',
  },
};
let release;
const held = new Promise((ok) => {
  release = ok;
});
const scripts = {
  progress: async (ctx) => {
    ctx.tools.show_block({
      block: {
        id: 'reading',
        type: 'progress',
        version: 1,
        title: 'Reading the papers',
        fallback: 'Reading four papers',
        steps: [
          { id: 'find', label: 'Find the papers', state: 'done', duration: '12 s' },
          { id: 'read', label: 'Read and summarize', state: 'running', progress: { done: 2, total: 4, unit: 'papers' }, eta: '3 min' },
          { id: 'write', label: 'Write the summary', state: 'pending' },
        ],
      },
    });
    await held;
  },
  diagram: (ctx) => ctx.text(`Here’s the flow:\n\n\`\`\`mermaid\n${BROKEN}\n\`\`\``),
  apps: (ctx) => {
    for (const [id, a] of Object.entries(APPS)) ctx.tools.show_app({ id, title: a.title, code: a.code });
  },
};
const agent = {
  name: 'mock',
  async deliver(_session, message, ctx) {
    calls.push(message);
    if (message.kind === 'user') await scripts[message.text]?.(ctx);
  },
};

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-feedback-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
app.rt.adapters.register(agent);
const page = await launch({ port: CHROME });
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = fn();
    if (v) return v;
  }
  return null;
};

try {
  const rt = app.rt;
  const project = Object.values(rt.s.projects)[0];
  const persona = rt.createPersona({ handle: 'drawer' });
  const thread = rt.createThread({ projectId: project.id, title: 'Feedback checks', personaIds: [persona.id] });
  await page.size(1280, 900);
  await page.goto(`${app.origin}/#/t/${thread.id}`);

  // #46: a diagram that can’t be drawn.
  rt.sendMessage(thread.id, { text: 'diagram' });
  const lint = await until(() => calls.find((m) => m.kind === 'lint'));
  const problem = lint?.problems?.find((p) => p.code === 'diagram-error');
  check(!!problem, '#46: the agent gets a lint turn for the diagram that couldn’t be drawn');
  check(/line 2/.test(problem?.message ?? '') && /Parse error/.test(problem?.message ?? ''), '#46: it has Mermaid’s message and line');
  check(problem?.scope?.excerpt === BROKEN, '#46: it quotes the diagram');
  const frame = await page.evaluate(
    `(() => { const f = document.querySelector('figure.diagram'); return f && { failed: f.querySelector('iframe')?.dataset.failed, source: [...f.querySelectorAll('button')].some((b) => b.textContent === 'Show source') }; })()`,
  );
  check(frame?.failed === '1' && frame.source, '#46: the person still has the diagram frame and Show source');
  const { result } = await page.send('Runtime.evaluate', { expression: `document.querySelector('figure.diagram iframe')` });
  const { node } = await page.send('DOM.describeNode', { objectId: result.objectId });
  const session = page.frameSession(node.frameId);
  const shown = session
    ? (await page.send('Runtime.evaluate', { expression: `document.querySelector('.err')?.textContent ?? ''`, returnByValue: true }, session)).result.value
    : '';
  check(/couldn’t be drawn/.test(shown), '#46: the frame says the diagram couldn’t be drawn');
  await sleep(500);
  check(calls.filter((m) => m.kind === 'lint').length === 1, '#46: once');
  check(!page.logs.some((l) => /Diagram: /.test(l)), '#46: the error is reported, not just logged');

  // #53: apps too small to read, or showing only an error.
  rt.sendMessage(thread.id, { text: 'apps' });
  const checked = await until(() => Object.keys(APPS).every((id) => rt.s.apps[id] && rt.s.apps[id].check.status !== 'pending'), 30000);
  check(!!checked, '#53: the browser checked all three apps');
  const st = (id) => rt.s.apps[id]?.check ?? {};
  const codes = (id) => (st(id).problems ?? []).map((p) => p.code);
  console.log(`  tiny: ${st('tiny').status} ${codes('tiny').join(', ')}; readable: ${st('readable').status} ${codes('readable').join(', ')}`);
  check(st('readable').status === 'passed', '#53: the readable chart passes');
  check(st('tiny').status === 'note' && st('tiny').notes === true, '#53: the tiny chart is shown, with notes');
  for (const code of ['marks-too-small', 'text-too-small', 'dashes-too-fine']) check(codes('tiny').includes(code), `#53: the tiny chart gets ${code}`);
  check(
    (st('tiny').problems ?? []).some((p) => /^At 375 px/.test(p.message)) && (st('tiny').problems ?? []).some((p) => /^At 1280 px/.test(p.message)),
    '#53: measured at 375 and 1280 px',
  );
  check(st('missing').status === 'note' && codes('missing').includes('only-error'), '#53: an app showing only an error is flagged');
  const appLint = await until(() => calls.filter((m) => m.kind === 'lint').find((m) => m.problems.some((p) => p.scope.kind === 'app')), 20000);
  const about = new Set((appLint?.problems ?? []).map((p) => p.scope.id));
  check(about.has('tiny') && about.has('missing') && !about.has('readable'), '#53: one lint turn tells the agent about both');
  check(calls.filter((m) => m.kind === 'lint').length === 2, '#53: one lint turn for the turn that showed the apps');
  const note = await page.evaluate(`[...document.querySelectorAll('.app-note')].map((n) => n.textContent).find((t) => /marks are under 4 px/.test(t)) ?? ''`);
  check(/^Shown with notes for @drawer/.test(note), '#53: the person sees the app with notes, not as a failure');

  // #58: a progress block that moves, then is left running.
  rt.sendMessage(thread.id, { text: 'progress' });
  const LI = `document.querySelector('[data-progress] li[data-s="running"]')`;
  await page.waitFor(LI, { label: 'the running step' });
  const shots = process.env.SHOTS;
  const shoot = async (name) => {
    if (!shots) return;
    await page.evaluate(`document.querySelector('[data-progress]').scrollIntoView({ block: 'center' })`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const read = () =>
    page.evaluate(`(() => { const li = ${LI}; const b = li?.closest('[data-progress]'); return li && {
      count: li.querySelector('.p-count')?.textContent, bar: li.querySelector('.p-bar i')?.style.width,
      time: li.lastElementChild.textContent, spin: getComputedStyle(li.querySelector('.g-running')).animationName,
      updated: [...b.querySelectorAll('.block-head [data-since]')].map((e) => e.textContent).join('') }; })()`);
  const first = await read();
  check(first?.count === '2 of 4 papers · 3 min left' && first.bar === '50%', '#58: “2 of 4 papers” with a bar at half');
  check(/^Updated (just now|\d+ s ago)$/.test(first?.updated ?? ''), '#58: the block says when it last moved');
  check(first?.spin === 'pb-turn', '#58: the running glyph turns');
  await sleep(2200);
  const later = await read();
  check(!!later && later.time !== first?.time && /^\d+ s$/.test(later.time), `#58: the running step’s time goes up (${first?.time} → ${later?.time})`);
  await shoot('progress-running');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check((await read())?.spin === 'none', '#58: the glyph holds still with reduced motion');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  release();
  const STALLED = `document.querySelector('[data-progress] li[data-s="stalled"]')`;
  await page.waitFor(STALLED, { label: 'the stalled step' });
  const stalled = await page.evaluate(
    `(() => { const li = ${STALLED}; return { glyph: li.querySelector('.g').getAttribute('aria-label'), time: li.lastElementChild.textContent, color: getComputedStyle(li.querySelector('.t')).color, text: getComputedStyle(document.body).color }; })()`,
  );
  check(stalled.glyph === 'Stalled' && /^No update for /.test(stalled.time), '#58: a step left running looks stalled, and says for how long');
  check(stalled.color !== stalled.text, '#58: a stalled step is dimmed');
  const told = await until(() => calls.filter((m) => m.kind === 'lint').find((m) => m.problems.some((p) => p.code === 'steps-left-running')));
  check(!!told, '#58: the agent is told to close the step');
  await shoot('progress-stalled');
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

finish();
