// #247, from the integrator’s review: a field or column id like `constructor` read Object’s own value when the person
// left it out, so another agent read “Notes: function Object() { [native code] }” as the person’s answer, and a table’s
// row action said “Open: function Object()…” in their voice. Only values the person sent count.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeItem } from '../server/item-lines.mjs';
import { buildEvent } from '../shared/events.mjs';

const form = {
  id: 'volumes',
  type: 'form',
  version: 1,
  fallback: 'x',
  title: 'Volumes',
  fields: [
    { id: 'q', label: 'Questions', kind: 'number' },
    { id: 'constructor', label: 'Notes', kind: 'text' },
  ],
};

test('another agent reads only the form fields the person answered, whatever their ids', () => {
  const item = { id: 'it_1', kind: 'block', valid: true, handle: 'alpha', block: form, answered: true, answer: { action: 'submit', values: { q: 12 } } };
  const line = describeItem(null, item, null, 10000, null);
  assert.ok(line.includes('The person answered:\n- Questions: 12'), line);
  assert.ok(!line.includes('Notes:'), line);
});

test('a table’s row action names the row when its first cell is missing, whatever the column’s id', () => {
  const table = {
    id: 't',
    type: 'table',
    version: 1,
    fallback: 'x',
    columns: [{ id: 'constructor', label: 'Name' }],
    rows: [{ id: 'r1', cells: {} }],
    rowAction: { id: 'open', label: 'Open' },
  };
  assert.equal(buildEvent(table, 'open', { rowId: 'r1' }).voice, 'Open: r1');
});

test('a review takes only its three verdicts, not a name Object has', () => {
  const review = { id: 'r', type: 'review', version: 1, fallback: 'x', format: 'markdown', content: 'Plan' };
  assert.equal(buildEvent(review, 'submit', { verdict: 'toString', comments: [{ line: 1, text: 'Looks fine.' }] }).ok, false);
  assert.equal(buildEvent(review, 'submit', { verdict: 'approve' }).voice, 'Submitted review: Approve');
});
