import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvent } from '../shared/events.mjs';

const choice = { id: 'freq', type: 'choice', version: 1, fallback: 'x', multiple: true, max: 2,
  options: [{ id: 'weekly', label: 'weekly' }, { id: 'mon9', label: 'Monday 9:00' }, { id: 'fri', label: 'Friday 17:00' }], other: { label: 'Something else' } };

test('a choice builds one event and a line in your voice', () => {
  const r = buildEvent(choice, 'choose', { selected: ['weekly', 'mon9'] });
  assert.deepEqual(r, { ok: true, event: { blockId: 'freq', action: 'choose', values: { selected: ['weekly', 'mon9'] } }, voice: 'Chose: weekly · Monday 9:00' });
});

test('a choice rejects unknown options, too many, and nothing', () => {
  assert.equal(buildEvent(choice, 'choose', { selected: ['nope'] }).ok, false);
  assert.match(buildEvent(choice, 'choose', { selected: ['weekly', 'mon9', 'fri'] }).error, /up to 2/);
  assert.match(buildEvent(choice, 'choose', { selected: [] }).error, /at least one/);
  assert.match(buildEvent({ ...choice, multiple: false }, 'choose', { selected: ['weekly', 'mon9'] }).error, /only one/);
});

test('“other” text counts as a choice and shows in quotes', () => {
  const r = buildEvent(choice, 'choose', { selected: [], other: 'Dubliners' });
  assert.equal(r.voice, 'Chose: “Dubliners”');
});

const form = { id: 'plan', type: 'form', version: 1, fallback: 'x', title: 'Reading plan', fields: [
  { id: 'name', label: 'Plan name', kind: 'text', required: true },
  { id: 'pages', label: 'Pages per day', kind: 'number', min: 5, max: 200 },
  { id: 'pace', label: 'Pace', kind: 'select', options: [{ id: 'steady', label: 'Steady' }] },
  { id: 'start', label: 'Start', kind: 'date' },
  { id: 'remind', label: 'Remind me', kind: 'toggle' },
  { id: 'notes', label: 'Notes', kind: 'longtext', maxLength: 10 },
] };

test('a form returns a message per field that says what to fix', () => {
  const r = buildEvent(form, 'submit', { name: '', pages: '400', pace: 'fast', start: '2026-02-30', notes: 'far too long here' });
  assert.equal(r.ok, false);
  assert.equal(r.error, '5 fields need fixing.');
  assert.deepEqual(r.fieldErrors, {
    name: 'This field is required.',
    pages: 'Enter a number from 5 to 200.',
    pace: 'Choose one of the options.',
    start: 'Enter a date as YYYY-MM-DD, for example 2026-10-27.',
    notes: 'Keep this under 10 characters.',
  });
});

test('a valid form converts numbers and toggles', () => {
  const r = buildEvent(form, 'submit', { name: 'Autumn', pages: '40', pace: 'steady', start: '2026-10-27', remind: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.event.values, { name: 'Autumn', pages: 40, pace: 'steady', start: '2026-10-27', remind: true });
  assert.equal(r.voice, 'Sent: Reading plan · Plan name “Autumn” · Pages per day 40');
});

test('a form rejects fields it doesn’t have', () => {
  assert.match(buildEvent(form, 'submit', { name: 'a', hacked: 1 }).error, /isn’t a field/);
});

test('confirm and cancel', () => {
  const b = { id: 'c', type: 'confirm', version: 1, fallback: 'x', statement: 's', confirmLabel: 'Remove 14 passages', cancelLabel: 'Keep them' };
  assert.equal(buildEvent(b, 'confirm').voice, 'Confirmed: Remove 14 passages');
  assert.equal(buildEvent(b, 'cancel').voice, 'Didn’t confirm: Keep them');
  assert.equal(buildEvent(b, 'maybe').ok, false);
});

test('table row actions and card actions', () => {
  const t = { id: 't', type: 'table', version: 1, fallback: 'x', columns: [{ id: 'book', label: 'Book' }], rows: [{ id: 'r1', cells: { book: 'Emma' } }], rowAction: { id: 'open', label: 'Open' } };
  assert.equal(buildEvent(t, 'open', { rowId: 'r1' }).voice, 'Open: Emma');
  assert.equal(buildEvent(t, 'open', { rowId: 'r9' }).ok, false);
  const c = { id: 'c', type: 'card', version: 1, fallback: 'x', title: 'Middlemarch', actions: [{ id: 'reindex', label: 'Re-index' }] };
  assert.equal(buildEvent(c, 'reindex').voice, 'Re-index · Middlemarch');
});

test('a review needs a verdict, and comments unless it approves', () => {
  const b = { id: 'r', type: 'review', version: 1, fallback: 'x', format: 'markdown', content: 'x' };
  assert.match(buildEvent(b, 'submit', { verdict: 'request_changes', comments: [] }).error, /Add a comment/);
  const r = buildEvent(b, 'submit', { verdict: 'request_changes', comments: [{ line: 5, text: 'Too coarse' }, { line: 9, text: 'Offsets?' }] });
  assert.equal(r.voice, 'Submitted review: Request changes · 2 comments');
  assert.equal(buildEvent(b, 'submit', { verdict: 'approve' }).voice, 'Submitted review: Approve');
});

test('apps send their own summary; the summary isn’t part of the values', () => {
  const b = { id: 'xp', type: 'app', version: 1, fallback: 'x', title: 'Corpus explorer', code: '<p></p>' };
  const r = buildEvent(b, 'use-passages', { passages: ['a', 'b', 'c'], summary: '3 passages' });
  assert.deepEqual(r.event.values, { passages: ['a', 'b', 'c'] });
  assert.equal(r.voice, 'Sent from Corpus explorer: 3 passages');
  assert.equal(buildEvent(b, 'not an id', {}).ok, false);
});

test('blocks that don’t take actions say so', () => {
  assert.equal(buildEvent({ id: 'p', type: 'progress' }, 'x').ok, false);
});
