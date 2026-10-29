import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptSyntaxErrors } from '../server/sandbox.mjs';

for (const [name, source] of [
  ['unclosed script elements', '<script>'.repeat(75_000)],
  ['unclosed script start tags', '<script '.repeat(75_000)],
])
  test(`#328 scans 600,000 characters of ${name} in under one second`, () => {
    const started = performance.now();
    const errors = scriptSyntaxErrors(source);
    const elapsed = performance.now() - started;

    assert.deepEqual(errors, []);
    assert.ok(elapsed < 1_000, `scanning took ${Math.round(elapsed)} ms`);
  });
