// A headless Chrome check of how the transcript renders what agents write, beside tools/check-transcript.mjs (which
// is at its length ceiling): a reply shared back from a topic thread draws its math and diagrams and links the
// thread’s glossary, as an agent’s reply does (#99).
//
//   node tools/check-transcript-render.mjs
//
// It runs its own Postbox, with the demo seed (mock agents) on a fresh data folder, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

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
  // A term defined in the topic thread, where the summary was written, and not in the conversation.
  rt.toolsFor(rt.sessionsIn(topic)[0].id).define_term({ term: 'label weight', definition: 'How many of the 300 claims carry a label.' });
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
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await page.synced(store.state.seq);
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

  check(!page.logs.length, `no errors in the page${page.logs.length ? `: ${page.logs.join('; ')}` : ''}`);
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

finish();
