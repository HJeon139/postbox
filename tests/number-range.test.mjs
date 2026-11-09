import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvent } from '../shared/events.mjs';
import { numberRange } from '../shared/number-range.mjs';

const form = (range) => ({ id: 'length', type: 'form', version: 1, fallback: 'x', fields: [{ id: 'words', label: 'Words', kind: 'number', ...range }] });
const errorOf = (range, words) => buildEvent(form(range), 'submit', { words }).fieldErrors?.words;

test('#822 a range’s hint reads as a sentence, “From 500 to 10,000.”, “At least 500.” or “No more than 10,000.”, and nothing without one', () => {
  assert.equal(numberRange({ min: 500, max: 10000 }).hint, 'From 500 to 10,000.');
  assert.equal(numberRange({ min: 500 }).hint, 'At least 500.');
  assert.equal(numberRange({ max: 10000 }).hint, 'No more than 10,000.');
  assert.equal(numberRange({ min: 0 }).hint, 'At least 0.');
  assert.equal(numberRange({}).hint, '');
});

test('#822 the error a submit gets uses the hint’s words, so the two can’t drift apart', () => {
  for (const range of [{ min: 500, max: 10000 }, { min: 500 }, { max: 10000 }, { min: 0 }]) {
    const { hint, error } = numberRange(range);
    const words = `${hint[0].toLowerCase()}${hint.slice(1)}`;
    assert.ok(error.endsWith(` ${words}`), `${JSON.stringify(range)}: “${error}” ends with “${words}”`);
    assert.equal(errorOf(range, 'About 600 words'), error);
  }
  assert.equal(errorOf({}, 'About 600 words'), 'Enter a number.');
});

test('#822 the range’s error keeps its wording', () => {
  assert.equal(numberRange({ min: 500, max: 10000 }).error, 'Enter a number from 500 to 10,000.');
  assert.equal(numberRange({ min: 500 }).error, 'Enter a number of at least 500.');
  assert.equal(numberRange({ max: 10000 }).error, 'Enter a number no more than 10,000.');
  assert.equal(numberRange({}).error, 'Enter a number.');
});
