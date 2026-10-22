// Headless checks for the checks that close the loop (M3): what the browser finds reaches the agent.
//   • #46: a diagram Mermaid can’t draw comes back to the agent as a lint turn, and the person still sees the
//     frame’s “couldn’t be drawn” text and Show source.
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
const scripts = {
  diagram: (ctx) => ctx.text(`Here’s the flow:\n\n\`\`\`mermaid\n${BROKEN}\n\`\`\``),
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
  await page.goto(`${app.origin}/?nocheck#/t/${thread.id}`);

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
