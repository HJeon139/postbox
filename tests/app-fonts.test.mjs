// #1322: an agent’s app takes Postbox’s own type. The catalog refuses app code that applies a font outside Postbox’s
// stacks and the generic families (shared/app-fonts.mjs), so show_app, update_app and show_block refuse it before
// anything is shown. Only the fonts it applies count: CSS in <style> and style attributes, SVG’s font-family, and
// script that sets a font. Text it only shows, in <pre>, <code> or a string, never does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FACE_ALIASES, STACK_FONTS } from '../shared/app-fonts.mjs';
import { validateBlock } from '../shared/catalog.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { setup, turn } from './blocks-fixture.mjs';

/** A template literal’s placeholder, as an app’s script writes one: ${name}. @param {string} name */
const hole = (name) => `\${${name}}`;
const app = (code) => validateBlock({ id: 'chart', type: 'app', version: 1, fallback: 'A chart.', code });
const refused = (code) => {
  const v = app(code);
  return v.ok ? [] : v.errors;
};
const TEXT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

test('#1322 an app that applies its own font is refused, however it applies it', () => {
  const cases = {
    '<style>@font-face { font-family: Brand; src: url(data:font/woff2;base64,AA) }</style>': /@font-face/,
    '<style>body { font-family: Georgia, serif; }</style>': /“Georgia”/,
    '<style>h1 { font-family: "Times New Roman"; }</style>': /“Times New Roman”/,
    '<style>p { font: italic 700 14px/1.4 Garamond, serif; }</style>': /“Garamond”/,
    '<p style="font-family: Courier New, monospace">Hi</p>': /“Courier New”/,
    "<p style='font: 12px Futura'>Hi</p>": /“Futura”/,
    '<svg><text font-family="Comic Sans MS">Hi</text></svg>': /“Comic Sans MS”/,
    '<script>el.style.fontFamily = "Papyrus";</script>': /“Papyrus”/,
    "<script>ctx.font = '12px Helvetica';</script>": /“Helvetica”/,
    [`<script>ctx.font = \`bold ${hole('size')}px Arial\`;</script>`]: /“Arial”/,
    "<script>d3.select('svg').attr('font-family', 'Impact');</script>": /“Impact”/,
    "<script>t.setAttribute('font-family', 'Verdana');</script>": /“Verdana”/,
  };
  for (const [code, why] of Object.entries(cases)) {
    const errors = refused(code);
    assert.equal(errors.length, 1, code);
    assert.match(errors[0], why, code);
  }
});

test('#1322 the refusal names the stacks an app may use, so the agent can fix it in one try', () => {
  const [error] = refused('<style>body { font-family: Georgia; }</style>');
  assert.ok(error.includes(TEXT_STACK), error);
  assert.ok(error.includes(MONO_STACK), error);
  assert.match(error, /a generic family such as serif/);
});

test('#1322 show_app’s description says the rule before the agent writes code', () => {
  const show = TOOL_DEFS.find((t) => t.name === 'show_app');
  assert.ok(show.description.includes(TEXT_STACK), show.description);
  assert.ok(show.description.includes(MONO_STACK), show.description);
  assert.match(show.description, /generic famil/);
});

test('#1322 false positives: text an app only shows is never read as a font it applies', () => {
  for (const code of [
    // A CSS lesson, shown in <pre> and <code>.
    '<pre>p { font-family: Georgia, serif; }</pre>',
    '<p>Set <code>font: 12px Garamond</code> on the heading.</p>',
    '<pre>&lt;p style="font-family: Georgia"&gt;</pre>',
    // A string a script shows, not one it applies.
    "<script>out.textContent = 'body { font-family: Georgia; }';</script>",
    '<script>const tip = `Try font-family: Futura`; note.textContent = tip;</script>',
    // A comment in a stylesheet.
    '<style>/* was font-family: Georgia */ p { color: var(--text); }</style>',
  ])
    assert.deepEqual(refused(code), [], code);
});

test('#1322 false positives: generic families are allowed, serif among them', () => {
  for (const family of [
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
    'math',
    'emoji',
    'fangsong',
  ])
    assert.deepEqual(refused(`<style>blockquote { font-family: ${family}; }</style>`), [], family);
  assert.deepEqual(refused('<p style="font: italic 16px/1.5 serif">A quote.</p>'), []);
  assert.deepEqual(refused("<script>ctx.font = '11px serif';</script>"), []);
});

test('#1322 an app that leaves the font to Postbox, or names Postbox’s own, is taken', () => {
  for (const code of [
    '<p>Plain</p>',
    '<style>p { font-size: 13px; font-weight: 600; font-style: italic; }</style>',
    '<style>body { font-family: inherit; } code { font-family: var(--mono); }</style>',
    `<style>body { font: inherit; } small { font: 12px/1.3 ${TEXT_STACK}; }</style>`,
    `<style>pre { font-family: ${MONO_STACK}; }</style>`,
    `<script>ctx.font = '12px sans-serif'; ctx.font = \`600 ${hole('s')}px system-ui\`;</script>`,
    '<svg><text font-family="monospace" font-size="10">x</text></svg>',
    // A family held in a variable can’t be read, so it’s left alone rather than refused.
    '<script>el.style.fontFamily = family;</script>',
  ])
    assert.deepEqual(refused(code), [], code);
});

test('#1322 another name for a face in Postbox’s stacks is Postbox’s font, as recorded agents write it', () => {
  // The raft and review showcases’ apps (tools/demo/showcase/), from real agents: SFMono-Regular is SF Mono’s
  // PostScript name, and BlinkMacSystemFont is Chrome’s name for the system face.
  assert.deepEqual(refused('<style>code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }</style>'), []);
  assert.deepEqual(refused('<style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; }</style>'), []);
});

test('#1322 every showcase app, recorded from real agents, passes the font rule unmodified', () => {
  for (const key of ['raft', 'elements', 'capacity', 'review', 'deps']) {
    const story = readFileSync(new URL(`../tools/demo/showcase/${key}/story.json`, import.meta.url), 'utf8');
    const codes = [...story.matchAll(/"code":\s*("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
    assert.ok(codes.length >= 2, `${key} has its apps`);
    for (const code of codes) assert.deepEqual(refused(code), [], key);
  }
});

test('#1322 the stacks an app may name are the ones workbench.css gives it, and no others', () => {
  const css = readFileSync(new URL('../app/workbench.css', import.meta.url), 'utf8');
  const stack = (re) =>
    re
      .exec(css)[1]
      .split(',')
      .map((f) =>
        f
          .trim()
          .replace(/^["']|["']$/g, '')
          .toLowerCase(),
      );
  const body = stack(/body \{[^}]*font: 14px\/1\.4 ([^;]+);/);
  const mono = stack(/code, pre, kbd, \.mono \{ font-family: ([^;]+);/);
  assert.deepEqual([...STACK_FONTS].sort(), [...new Set([...body, ...mono])].sort());
  for (const face of Object.values(FACE_ALIASES)) assert.ok(STACK_FONTS.has(face), `${face} is in a stack`);
});

test('#1322 show_app refuses an app with its own font, and nothing is shown', async () => {
  const { rt, store, t, adapter } = setup();
  const r = await turn(rt, adapter, t, (tools) =>
    tools.show_app({ id: 'chart', title: 'Chart', code: '<style>body { font-family: Georgia; }</style><p>Hi</p>' }),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /^The block wasn’t shown: code applies a font Postbox doesn’t use, “Georgia”/);
  assert.deepEqual(
    store.items(t.id).filter((i) => i.kind === 'block'),
    [],
  );
});
