// Headless checks for the checks that close the loop (M3): what the browser finds reaches the agent.
//   • #46: a diagram Mermaid can’t draw comes back to the agent as a lint turn, and the person still sees the
//     frame’s “couldn’t be drawn” text and Show source.
//   • #53: the app check measures marks, labels and dashes at 375 and 1280 px. A chart too small to read, and an
//     app that shows only an error, are shown with notes and reach the agent; a readable chart passes.
//
//   node tools/check-feedback.mjs
//
// It runs its own Postbox, with a fresh data folder and a scripted agent, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';

const PORT = Number(process.env.PB_PORT ?? 4610);
const CHROME = Number(process.env.PB_CHROME_PORT ?? 9810);

const free = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });
for (const p of [PORT, CHROME])
  if (!(await free(p))) {
    console.error(`Port ${p} is in use. Set PB_PORT or PB_CHROME_PORT to a free one.`);
    process.exit(1);
  }

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
const scripts = {
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
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};
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
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check${failures.length === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\nAll feedback checks passed.');
process.exit(0);
