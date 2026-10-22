// The limits agents are told are the limits Postbox enforces (#50): one module, read by the catalog, the event
// builder, the app kit, the guide and the MCP tool descriptions.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { agentGuide, guideText } from '../server/adapters/guide.mjs';
import { TOOL_DEFS } from '../server/mcp.mjs';
import { sandboxPage } from '../server/sandbox.mjs';
import { validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { LIMITS, limitText, PALETTES } from '../shared/limits.mjs';

const names = /** @type {(keyof typeof LIMITS)[]} */ (Object.keys(LIMITS));

test('every limit in shared/limits.mjs is written into the guide from the module', () => {
  const plain = guideText();
  names.forEach((name, i) => {
    // An unusual value for this one limit must show up in the guide, so the guide reads it rather than a copy.
    const odd = name.endsWith('Bytes') ? (900 + i) * 1024 : 90_000 + i * 7;
    const text = limitText(name, { ...LIMITS, [name]: odd });
    assert.ok(!plain.includes(text), `${text} is already in the guide`);
    assert.ok(guideText({ ...LIMITS, [name]: odd }).includes(text), `The guide doesn’t name the limit “${name}”. Add it from shared/limits.mjs.`);
  });
  // And the guide agents get is that one.
  assert.ok(agentGuide({ persona: { handle: 'a' }, handles: ['a'] }).includes(plain));
});

test('the MCP tool descriptions name the limits each tool needs', () => {
  const said = (tool) => TOOL_DEFS.find((t) => t.name === tool)?.description ?? '';
  const blocks = names.filter((n) => !['eventBytes', 'appCode'].includes(n));
  for (const name of blocks) assert.ok(said('show_block').includes(limitText(name)), `show_block doesn’t name ${name}`);
  for (const name of ['eventBytes', 'appCode']) assert.ok(said('show_app').includes(limitText(name)), `show_app doesn’t name ${name}`);
  assert.match(said('show_app'), /64 KB/);
});

test('the catalog enforces the limits from the module', () => {
  const base = { id: 'b', version: 1, fallback: 'x' };
  const opts = (k) => Array.from({ length: k }, (_, i) => ({ id: `o${i}`, label: `O${i}` }));
  const cases = [
    ['choiceOptions', (k) => ({ ...base, type: 'choice', options: opts(k) })],
    ['formFields', (k) => ({ ...base, type: 'form', fields: opts(k).map((o) => ({ ...o, kind: 'text' })) })],
    ['tableRows', (k) => ({ ...base, type: 'table', columns: [{ id: 'c', label: 'C' }], rows: opts(k).map((o) => ({ id: o.id, cells: { c: 1 } })) })],
    ['cardActions', (k) => ({ ...base, type: 'card', actions: opts(k) })],
    ['progressSteps', (k) => ({ ...base, type: 'progress', steps: opts(k).map((o) => ({ ...o, state: 'pending' })) })],
    ['fallback', (k) => ({ ...base, type: 'code', code: 'x', fallback: 'x'.repeat(k) })],
    ['appCode', (k) => ({ ...base, type: 'app', code: 'x'.repeat(k) })],
  ];
  for (const [name, make] of /** @type {[keyof typeof LIMITS, (k: number) => object][]} */ (cases)) {
    assert.equal(validateBlock(make(LIMITS[name])).ok, true, `${name} at its limit`);
    assert.equal(validateBlock(make(LIMITS[name] + 1)).ok, false, `${name} over its limit`);
  }
});

test('an app event over the limit is refused, and the error names the limit', () => {
  const app = { id: 'ap', type: 'app', title: 'Explorer' };
  const r = buildEvent(app, 'pairs', { ids: 'x'.repeat(LIMITS.eventBytes) });
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).error, /larger than 64 KB/);
  assert.equal(buildEvent(app, 'pairs', { ids: 'x'.repeat(LIMITS.eventBytes - 100) }).ok, true);
});

/** Runs the app kit as a sandbox page would, with the init the server writes into the page, and records what it posts. */
function runKit(init) {
  const posted = [];
  const ctx = /** @type {any} */ ({
    document: {
      currentScript: { dataset: { init: JSON.stringify(init) } },
      documentElement: { dataset: {} },
      createElement: () => ({}),
      head: { appendChild() {} },
    },
    addEventListener() {},
    parent: { postMessage: (m) => posted.push(m) },
  });
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../app/kit/kit.js', import.meta.url), 'utf8'), ctx);
  return { postbox: ctx.postbox, events: () => posted.filter((m) => m.type === 'event') };
}

test('postbox.send over the limit rejects inside the app, names the limit, and posts nothing', async () => {
  const page = sandboxPage({ origin: 'http://127.0.0.1:1', app: { id: 'ap', title: 'Explorer' }, version: { v: 1, code: '' }, theme: 'dark' });
  const attr = page.html.match(/data-init="([^"]*)"/)?.[1] ?? '';
  const init = JSON.parse(attr.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  assert.equal(init.limits.eventBytes, LIMITS.eventBytes);

  const { postbox, events } = runKit(init);
  const pairs = Array.from({ length: 1258 }, (_, i) => ({ id: `p${i}`, claim: 'A claim about a protein and a disease. '.repeat(2) }));
  await assert.rejects(postbox.send('pairs', { pairs }, 'Send 1,258 pairs'), (e) => {
    assert.match(e.message, /larger than the 64 KB one event can carry, so nothing was sent/);
    assert.match(e.message, /Send ids/);
    return true;
  });
  assert.equal(events().length, 0);
  // The same hand-off by id fits.
  postbox.send('pairs', { ids: pairs.map((p) => p.id) }, 'Send 1,258 pairs');
  assert.equal(events().length, 1);
});

test('every palette token is defined in the stylesheet, in both themes (#52)', () => {
  const css = readFileSync(new URL('../app/workbench.css', import.meta.url), 'utf8');
  for (const p of PALETTES)
    for (const token of p.tokens) {
      const defined = css.match(new RegExp(`(?:^|[\\s;{])${token}:`, 'gm')) ?? [];
      assert.ok(defined.length >= 2, `${token} (${p.for}) isn’t defined for both themes in app/workbench.css`);
    }
});

test('the guide and show_app say which palette is for what, from the module (#52)', () => {
  const guide = guideText();
  const showApp = TOOL_DEFS.find((t) => t.name === 'show_app')?.description ?? '';
  for (const p of PALETTES) {
    assert.ok(guide.includes(`${p.name} for ${p.for}: ${p.when}`), `The guide doesn’t say when to use ${p.name}`);
    assert.ok(showApp.includes(`${p.name} for ${p.for}`), `show_app doesn’t name ${p.name}`);
  }
  // Status colors are for status only.
  assert.match(guide, /--good and --alert for status only: .*never for a category/);
});
