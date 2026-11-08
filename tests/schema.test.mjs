// The schema language the block catalog is written in (shared/schema.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id, list, obj, str } from '../shared/schema.mjs';

const options = list(obj({ id: id(), label: str({ min: 1 }) }, ['id', 'label']), { unique: 'id' });
const errorsOf = (v) => {
  const errs = [];
  options(v, 'options', errs);
  return errs;
};

test('#552 a list’s unique check skips items without the key, which the item’s own check reports', () => {
  // { value, label }, as agents send a select’s options: each is missing its id, and none is a duplicate.
  const valued = errorsOf([
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ]);
  assert.equal(valued.filter((e) => /is required/.test(e)).length, 3);
  assert.deepEqual(
    valued.filter((e) => /two items/.test(e)),
    [],
  );
  // Strings, and items that aren’t objects at all.
  assert.deepEqual(
    errorsOf(['Small', 'Medium', null, 3]).filter((e) => /two items/.test(e)),
    [],
  );
});

test('a list’s unique check still reports a real duplicate, once, beside items without the key', () => {
  const errs = errorsOf([{ id: 'a', label: 'A' }, { label: 'No id' }, { id: 'a', label: 'B' }, 'Small']);
  assert.deepEqual(
    errs.filter((e) => /two items/.test(e)),
    ['options has two items with the id “a”.'],
  );
});
