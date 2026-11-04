// Which element of an app the runner clicks (tools/uat/app-target.mjs): the deepest match, so a row holding a label and
// its button gives the button. needsnav.md phase 3’s run on 4 November clicked the row’s empty middle four times.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepestMatch, targetScript } from '../tools/uat/app-target.mjs';

/** A fake element: its own text, and the elements inside it. */
function el(name, text, kids = []) {
  const all = () => kids.flatMap((k) => [k, ...k.all()]);
  return { name, textContent: [text, ...kids.map((k) => k.textContent)].join(' '), all, contains: (o) => all().includes(o) };
}

test('a row holding a label and its button gives the button, not the row', () => {
  const button = el('button', 'Send to @critic');
  const row = el('li', '', [el('span', 'Step 1: Read the corpus'), button]);
  assert.equal(deepestMatch([row, button], 'send to @critic'), button);
});

test('a target only the row’s label holds gives the row, the deepest candidate that matches', () => {
  const button = el('button', 'Send to @critic');
  const row = el('li', '', [el('span', 'Step 1: Read the corpus'), button]);
  assert.equal(deepestMatch([row, button], 'Read the corpus'), row);
});

test('no match gives null, and the first of two separate matches wins, as before', () => {
  const a = el('button', 'Allow');
  const b = el('button', 'Allow all');
  assert.equal(deepestMatch([a, b], 'nothing here'), null);
  assert.equal(deepestMatch([a, b], 'allow'), a);
});

test('its source runs on its own, as the runner sends it into the app’s frame', () => {
  const inFrame = new Function(`return (${deepestMatch})`)();
  const button = el('button', 'Go');
  assert.equal(inFrame([el('li', '', [button]), button], 'go'), button);
});

test('the frame script carries the deepest-match rule and the target text, as source that parses', () => {
  const src = targetScript('Send to @critic');
  assert.match(src, /holdsAnother/);
  assert.match(src, /"Send to @critic"/);
  assert.doesNotThrow(() => new Function(`return ${src.replace(/document\.querySelectorAll\([^)]*\)/, '[]')}`));
});
