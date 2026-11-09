// #951: a choice or select whose options are all strings gets one error showing an option’s shape (#455, #939). Its
// example must itself pass: an id starts with a letter or digit, so a label like “.NET” gives the id “net”, not
// “.net”, which would be refused on the agent’s next try.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBlock } from '../shared/catalog.mjs';

const choice = (options) => ({ id: 'c1', type: 'choice', version: 1, fallback: 'x', options });

/** The example option the error shows for these string options. */
function example(options) {
  const [error] = validateBlock(choice(options)).errors;
  const json = /must be objects like (\{.*\}), not strings\./.exec(error)?.[1];
  assert.ok(json, error);
  return JSON.parse(json);
}

test('#951 a label that starts with punctuation gives an example id that starts with a letter or digit', () => {
  assert.deepEqual(example(['.NET', 'Java']), { id: 'net', label: '.NET' });
  assert.deepEqual(example(['_x']), { id: 'x', label: '_x' });
  assert.deepEqual(example([':y']), { id: 'y', label: ':y' });
});

test('#951 a label with no letter or digit is passed over for the next, else the example is “one”', () => {
  assert.deepEqual(example(['…', 'Rust']), { id: 'rust', label: 'Rust' });
  assert.deepEqual(example(['!!', '??']).id, 'one');
});

test('#951 following the example passes, for each of those labels', () => {
  for (const labels of [['.NET', 'Java'], ['_x'], [':y'], ['…', 'Rust'], ['!!', '??']]) {
    const { id, label } = example(labels);
    const fixed = validateBlock(choice([{ id, label }]));
    assert.equal(fixed.ok, true, `${JSON.stringify(labels)}: ${fixed.errors}`);
  }
});
