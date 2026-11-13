// #1322: an agent’s app takes Postbox’s own type. The catalog refuses app code that names a font outside Postbox’s
// stacks (shared/app-fonts.mjs), so show_app, update_app and show_block refuse it before anything is shown.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { APP_FONTS } from '../shared/app-fonts.mjs';
import { validateBlock } from '../shared/catalog.mjs';
import { setup, turn } from './blocks-fixture.mjs';

/** A template literal’s placeholder, as an app’s script writes one: ${name}. @param {string} name */
const hole = (name) => `\${${name}}`;
const app = (code) => validateBlock({ id: 'chart', type: 'app', version: 1, fallback: 'A chart.', code });
const refused = (code) => {
  const v = app(code);
  return v.ok ? [] : v.errors;
};

test('#1322 an app that names its own font is refused, however it names it', () => {
  const cases = {
    '<style>@font-face { font-family: Brand; src: url(data:font/woff2;base64,AA) }</style>': /@font-face/,
    '<style>body { font-family: Georgia, serif; }</style>': /“Georgia”/,
    '<style>h1 { font-family: "Times New Roman"; }</style>': /“Times New Roman”/,
    '<style>p { font: italic 700 14px/1.4 Garamond, serif; }</style>': /“Garamond”/,
    '<svg><text font-family="Comic Sans MS">Hi</text></svg>': /“Comic Sans MS”/,
    '<script>el.style.fontFamily = "Papyrus";</script>': /“Papyrus”/,
    "<script>ctx.font = '12px Helvetica';</script>": /“Helvetica”/,
    [`<script>ctx.font = \`bold ${hole('size')}px Arial\`;</script>`]: /“Arial”/,
    "<script>d3.select('svg').attr('font-family', 'Impact');</script>": /“Impact”/,
    '<style>body { font-family: serif; }</style>': /“serif”/,
  };
  for (const [code, why] of Object.entries(cases)) {
    const errors = refused(code);
    assert.equal(errors.length, 1, code);
    assert.match(errors[0], why, code);
    assert.match(errors[0], /an app takes Postbox’s type/, code);
  }
});

test('#1322 an app that leaves the font to Postbox, or names Postbox’s own, is taken', () => {
  for (const code of [
    '<p>Plain</p>',
    '<style>p { font-size: 13px; font-weight: 600; font-style: italic; }</style>',
    '<style>body { font-family: inherit; } code { font-family: var(--mono); }</style>',
    '<style>body { font: inherit; } small { font: 12px/1.3 system-ui, sans-serif; }</style>',
    '<style>pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }</style>',
    `<script>ctx.font = '12px sans-serif'; ctx.font = \`600 ${hole('s')}px system-ui\`;</script>`,
    '<svg><text font-family="monospace" font-size="10">x</text></svg>',
    // A template the scanner can’t read is left alone rather than refused.
    '<script>el.style.fontFamily = family;</script>',
  ])
    assert.deepEqual(refused(code), [], code);
});

test('#1322 the fonts an app may name are the ones workbench.css gives it, and no others', () => {
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
  const families = [...APP_FONTS].filter((f) => !['inherit', 'initial', 'unset', 'revert'].includes(f));
  assert.deepEqual(families.sort(), [...new Set([...body, ...mono])].sort());
});

test('#1322 show_app refuses an app with its own font, and nothing is shown', async () => {
  const { rt, store, t, adapter } = setup();
  const r = await turn(rt, adapter, t, (tools) =>
    tools.show_app({ id: 'chart', title: 'Chart', code: '<style>body { font-family: Georgia; }</style><p>Hi</p>' }),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /^The block wasn’t shown: code names a font Postbox doesn’t use, “Georgia”/);
  assert.deepEqual(
    store.items(t.id).filter((i) => i.kind === 'block'),
    [],
  );
});
