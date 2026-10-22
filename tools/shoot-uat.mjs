// Screenshots for the UAT docs (tests/uat/): plays the demo in headless Chrome, then captures each UI
// component on its own, cropped to the element, at 1280 px in light mode.
//
//   node tools/shoot-uat.mjs            → tests/uat/screenshots/<component>.png
//   ONLY=rail,composer node tools/shoot-uat.mjs   to retake some
//
// Each spec names the view to open, how to find the element (a JS expression that returns it), and
// optionally what to do first (open a menu, type into the composer).

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { play } from './demo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests', 'uat', 'screenshots');
// PB_PORT and PB_CHROME_PORT move it, so sessions working in parallel don’t collide.
const PORT = Number(process.env.PB_PORT ?? 4291);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

// Finders: JS expressions run in the page.
const item = (text) => `[...document.querySelectorAll('.transcript > .item')].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
const block = (title) =>
  `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.block-head, .app-head, .appframe') && n.textContent.includes(${JSON.stringify(title)}))`;
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
/** Captures taken during the demo, at the moment a scene is on screen: [scene, name, finder, prepare?]. */
const DURING = [
  ['15-permission', 'permission-card', item('Let @indexer run a command')],
  ['15b-refusal', 'refusal-card', item('Refused: @indexer’s subagent')],
  ['15b-refusal', 'activity-steps', `[...document.querySelectorAll('.transcript details.activity')].at(-1)?.closest('.item')`, 'open-activity-last'],
  ['10-plus-menu', 'plus-menu', q('.menu'), 'plus'],
  ['10-plus-menu', 'proposal-card', item('New teammate')],
  ['09-errors', 'failed-reply', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.callout[role=alert]'))`],
  ['09-errors', 'invalid-block', item('Can’t show this block')],
  ['09-errors', 'app-crashed', item('stopped working')],
  ['09-errors', 'stopped-reply', item('Stopped by you')],
  ['03-thread', 'queued-message', q('.composer .queued, .composer [class*="queue"]')],
  ['08-wakes', 'hop-confirm', item('wake @')],
  [
    '08-wakes',
    'side-thread-link',
    `[...document.querySelectorAll('.transcript > .item')].find((n) => n.textContent.includes('asked') && n.textContent.includes('Open'))`,
  ],
];

/** Captures after the demo: [name, hash or thread title, finder, prepare?]. */
const AFTER = [
  ['top-bar', 'Corpus planning', q('header.topbar')],
  ['postbox-menu', 'Corpus planning', q('.menu'), 'postbox-menu'],
  ['conversation-menu', 'Corpus planning', q('.menu'), 'conversation-menu'],
  ['rail', 'Corpus planning', q('nav.rail')],
  ['rail-row', 'Corpus planning', q('nav.rail a.row[aria-current]')],
  ['overview', '#/', q('main.ov')],
  ['overview-card', '#/', `[...document.querySelectorAll('.ov-col')].find((n) => n.classList.contains('needs'))`],
  ['session-menu', '#/', q('.menu'), 'session-menu'],
  ['archived-sessions', '#/archived', q('main.ov')],
  ['threads-view', 'threads', q('main.threads-view')],
  ['composer', 'Corpus explorer', q('.composer')],
  ['mention-menu', 'Corpus planning', q('.mention-menu, .menu'), 'mention'],
  ['empty-conversation', 'Agent memory papers', q('.transcript')],
  ['user-message', 'Corpus explorer', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.me-card'))`],
  [
    'agent-reply',
    'Corpus explorer',
    `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.who pb-ring') && n.querySelector('.md p'))`,
  ],
  ['activity-line', 'Index the shelf', `[...document.querySelectorAll('.transcript details.activity')].at(0)?.closest('.item')`, 'open-activity'],
  ['explainer-citations', 'ReAct, step by step', item('Step 1')],
  ['citation-card', 'ReAct, step by step', q('.hovercard'), 'cite'],
  ['glossary-term', 'ReAct, step by step', item('observation budget')],
  ['mermaid-diagram', 'ReAct, step by step', `document.querySelector('.diagram')`],
  ['math', 'ReAct, step by step', `document.querySelector('.md-math[data-display="true"]')`],
  ['reply-in-thread', 'ReAct, step by step', `[...document.querySelectorAll('.msg-actions')].find((n) => n.textContent.includes('repl'))?.closest('.item')`],
  ['shared-summary', 'ReAct, step by step', `document.querySelector('.shared-card')?.closest('.item')`],
  ['topic-thread-panel', 'topic', q('aside.sidepanel')],
  ['side-thread-panel', 'side', q('aside.sidepanel')],
  ['compaction-divider', 'Corpus planning', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.textContent.includes('Context compacted'))`],
  ['system-wake-line', 'Corpus planning', item('You woke')],
  ['progress-block', 'Corpus planning', block('Index the shelf')],
  [
    'choice-block',
    'Catalog tour',
    `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.chips button') && n.querySelector('.block'))`,
  ],
  [
    'form-block',
    'Catalog tour',
    `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.block form, .block input, .block select'))`,
  ],
  ['table-block', 'Catalog tour', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.block table'))`],
  ['card-block', 'Catalog tour', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.block dl.facts'))`],
  ['confirm-block', 'Catalog tour', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.textContent.includes('Remove 14 passages'))`],
  ['image-block', 'Catalog tour', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.block img'))`],
  [
    'code-block',
    'Catalog tour',
    `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.block pre') && n.textContent.includes('Copy'))`,
  ],
  ['review-block', 'Corpus schema spec', `[...document.querySelectorAll('.transcript > .item')].find((n) => n.querySelector('.rv-doc'))`],
  ['agent-app', 'Corpus explorer', `document.querySelector('.appframe')?.closest('.item')`],
  ['app-version-menu', 'Corpus explorer', q('.menu'), 'app-versions'],
  ['chart-app', 'Corpus dashboard', `document.querySelector('.appframe')?.closest('.item')`],
  ['narration-player', 'ReAct, out loud', `document.querySelector('.appframe')?.closest('.item')`],
  ['diagram-lint', 'Indexing pipeline', q('.transcript')],
  ['new-agent-sheet', 'Corpus explorer', q('.dialog'), 'new-agent'],
  ['new-room-sheet', 'Corpus explorer', q('.dialog'), 'new-room'],
  ['rename-sheet', 'Corpus planning', q('.dialog'), 'rename'],
  ['delete-conversation-sheet', 'Corpus planning', q('.dialog'), 'delete-conversation'],
  ['delete-session-sheet', '#/', q('.dialog'), 'delete-session'],
  ['command-palette', 'Corpus explorer', q('.dialog'), 'palette'],
  ['settings-appearance', 'Corpus explorer', q('.dialog'), 'settings:appearance'],
  ['settings-personas', 'Corpus explorer', q('.dialog'), 'settings:personas'],
  ['settings-persona-editor', 'Corpus explorer', q('.dialog'), 'settings:persona-edit'],
  ['settings-projects', 'Corpus explorer', q('.dialog'), 'settings:projects'],
  ['settings-connection', 'Corpus explorer', q('.dialog'), 'settings:connection'],
  ['folder-picker', 'Corpus explorer', q('.dialog'), 'folder-picker'],
  ['toast', 'Corpus explorer', q('.toast'), 'toast'],
];

const PREPARE = {
  plus: `document.querySelector('[aria-label="Add a file or a new agent"]').click()`,
  'postbox-menu': `document.querySelector('button.brand').click()`,
  'conversation-menu': `document.querySelector('header.topbar [aria-label^="Actions for"]').click()`,
  'session-menu': `[...document.querySelectorAll('.ov-col')][0].querySelector('[aria-haspopup="menu"]').click()`,
  mention: `(() => { const t = document.getElementById('composer-input'); t.focus(); t.value = '@'; t.setSelectionRange(1, 1); t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  'open-activity': `document.querySelector('.transcript details.activity')?.setAttribute('open', '')`,
  'open-activity-last': `(() => { const d = [...document.querySelectorAll('.transcript details.activity')].at(-1); d?.setAttribute('open', ''); d?.querySelector('li.thought details')?.setAttribute('open', ''); })()`,
  cite: `(() => { const c = document.querySelector('.cite'); c.scrollIntoView({ block: 'center' }); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
  'app-versions': `document.querySelector('.appframe [aria-haspopup="menu"]')?.click()`,
  'new-agent': `(() => { document.querySelector('[aria-label="Add a file or a new agent"]').click(); [...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('From a boilerplate')).click(); })()`,
  'new-room': `document.querySelector('[aria-label="New room"]').click()`,
  rename: `(() => { document.querySelector('header.topbar [aria-label^="Actions for"]').click(); [...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('Rename')).click(); })()`,
  'delete-conversation': `(() => { document.querySelector('header.topbar [aria-label^="Actions for"]').click(); [...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('Delete')).click(); })()`,
  'delete-session': `(() => { [...document.querySelectorAll('.ov-col')][0].querySelector('[aria-haspopup="menu"]').click(); [...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('Delete')).click(); })()`,
  palette: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`,
  'settings:appearance': `document.querySelector('[aria-label="Settings"]').click()`,
  'settings:personas': `(() => { document.querySelector('[aria-label="Settings"]').click(); [...document.querySelectorAll('.dialog [role=tab], .dialog button')].find((b) => b.textContent.trim() === 'Personas').click(); })()`,
  'settings:persona-edit': `(() => { document.querySelector('[aria-label="Settings"]').click(); [...document.querySelectorAll('.dialog [role=tab], .dialog button')].find((b) => b.textContent.trim() === 'Personas').click(); setTimeout(() => [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'Edit').click(), 100); })()`,
  'settings:projects': `(() => { document.querySelector('[aria-label="Settings"]').click(); [...document.querySelectorAll('.dialog [role=tab], .dialog button')].find((b) => b.textContent.trim() === 'Projects').click(); })()`,
  'settings:connection': `(() => { document.querySelector('[aria-label="Settings"]').click(); [...document.querySelectorAll('.dialog [role=tab], .dialog button')].find((b) => b.textContent.trim() === 'Connect an agent').click(); })()`,
  'folder-picker': `(() => { document.querySelector('[aria-label="Add a file or a new agent"]').click(); [...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('From the project folder')).click(); })()`,
  toast: `import('/app/js/ui.mjs').then((m) => m.toast({ title: 'Archived @critic’s session', action: { label: 'Restore', run: () => {} } }))`,
};

await mkdir(OUT, { recursive: true });
const dataDir = join(tmpdir(), `pb-uat-${process.pid}`);
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const origin = `http://127.0.0.1:${PORT}`;
const page = await launch({ port: Number(process.env.PB_CHROME_PORT ?? 9391) });
await page.size(1280, 1000, { theme: 'light' });
let loads = 0;
const goto = async (hash) => {
  await page.goto(`${origin}/?v=${++loads}${hash}`);
  await sleep(1200);
};

const missing = [];
async function capture(name, finder, prepare) {
  if (ONLY && !ONLY.has(name)) return;
  if (prepare) {
    await page.evaluate(PREPARE[prepare]).catch((e) => console.log(`  prepare ${prepare}: ${e.message}`));
    await sleep(700);
  }
  const rect = await page.evaluate(`(() => {
    const el = ${finder};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8 + scrollY), width: Math.min(r.width + 16, innerWidth), height: Math.min(r.height + 16, 2400) };
  })()`);
  if (!rect || rect.width < 4 || rect.height < 4) {
    missing.push(name);
    console.log(`  missing: ${name}`);
    return;
  }
  await sleep(300);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${name}.png  ${Math.round(rect.width)}×${Math.round(rect.height)}`);
}

let hash = '#/';
try {
  await goto(hash);
  await play({
    origin,
    speed: 0.3,
    log: (m) => console.log(`· ${m}`),
    view: async (h) => {
      hash = h;
      await goto(h);
    },
    shot: async (scene, { prepare } = {}) => {
      const due = DURING.filter(([s]) => s === scene);
      for (const [, name, finder, prep] of due) {
        await goto(hash);
        if (prepare) await prepare(page);
        await capture(name, finder, prep);
      }
    },
  });
  // After the demo: every remaining view.
  const st = await (await fetch(`${origin}/api/state`)).json();
  const byTitle = (t) => Object.values(st.state.threads).find((x) => x.title === t);
  const topic = Object.values(st.state.threads).find((x) => x.kind === 'topic');
  const side = Object.values(st.state.threads).find((x) => x.kind === 'side');
  const project = Object.values(st.state.projects)[0];
  const hashFor = (where) =>
    where.startsWith('#')
      ? where
      : where === 'threads'
        ? `#/p/${topic?.projectId ?? project.id}/threads`
        : where === 'topic'
          ? `#/t/${topic.parentId}/side/${topic.id}`
          : where === 'side'
            ? `#/t/${side.parentId}/side/${side.id}`
            : `#/t/${byTitle(where)?.id}`;
  for (const [name, where, finder, prep] of AFTER) {
    if (ONLY && !ONLY.has(name)) continue;
    await goto(hashFor(where));
    await capture(name, finder, prep);
  }
} finally {
  if (missing.length) console.log(`\nNot captured: ${missing.join(', ')}`);
  await page.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
