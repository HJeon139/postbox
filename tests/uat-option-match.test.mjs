// #1750: the UAT tester names a choice's option as it reads it, and on 25 Nov it sent an option's label and its
// description joined with “ — ”: “Mention it without a number — e.g. “compare against your category””. The chip draws
// the two as separate spans (app/js/blocks.mjs, `span.chip-text` with the label and `span.chip-desc`), so its text has
// no “ — ”, and the match found nothing. A stand-in page holds that chip and its neighbors, and the expression the driver
// sends is run against it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byOption } from '../tools/uat/selectors.mjs';

/** A chip as blocks.mjs draws an option with a description: its textContent is the label's and the description's spans, back to back. */
const chip = (label, description) => ({
  textContent: description ? `${label}${description}` : label,
  offsetParent: {},
  getAttribute: () => null,
  // The label's own span, as `span.chip-text > span` draws it; a chip with no description has none.
  querySelector: (sel) => (description && sel === '.chip-text > span' ? { textContent: label } : null),
  label,
});

const chips = [
  chip('Mention it without a number', 'e.g. “compare against your category”'),
  chip('Leave it out', 'only windowed figures appear'),
  chip('Text only'),
];

/** Runs the driver's expression in a page whose item holds these chips, and returns the label of the one it found. */
function found(expr, list = chips) {
  const doc = { querySelector: () => ({ querySelectorAll: () => list }) };
  const el = new Function('document', `return ${expr};`)(doc);
  return el?.label ?? null;
}

const SEL = 'button.chip, [role=radio], [role=checkbox], label';
const ITEM = `document.querySelector('[data-key="k"]')`;

test('an option named as its label and description joined with “ — ” is found by its label', () => {
  assert.equal(found(byOption(ITEM, SEL, 'Mention it without a number — e.g. “compare against your category”')), 'Mention it without a number');
});

test('an option named by its label alone, or by its whole text, is still found as before', () => {
  assert.equal(found(byOption(ITEM, SEL, 'Mention it without a number')), 'Mention it without a number');
  assert.equal(found(byOption(ITEM, SEL, 'text only')), 'Text only');
  assert.equal(found(byOption(ITEM, SEL, 'Leave it outonly windowed figures appear')), 'Leave it out');
});

test('a name that matches no option still finds none, so the step fails as before', () => {
  assert.equal(found(byOption(ITEM, SEL, 'Something else — entirely')), null);
});

test('the label fallback picks only an exact label, not the first label that contains it', () => {
  // hydrant-critic's case: “Weekly with alerts” is drawn first, and the tester means “Weekly”.
  const list = [chip('Weekly with alerts', 'a summary and an alert on drops'), chip('Weekly', 'every Monday')];
  assert.equal(found(byOption(ITEM, SEL, 'Weekly — every Monday'), list), 'Weekly');
  // And a joined name whose label is no option's whole label finds none, so the step fails rather than guess.
  assert.equal(found(byOption(ITEM, SEL, 'Week — every Monday'), list), null);
});
