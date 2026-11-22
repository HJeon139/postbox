// #480: the persona sheet says what each backend does with memory, in one line, as #208 and #479 left it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryLine } from '../shared/agent-memory.mjs';

test('#480 each backend’s memory line', () => {
  assert.equal(memoryLine('claude-code'), 'Memory: its own. No other agent, and none of your own sessions, reads it.');
  assert.equal(memoryLine('agent-sdk'), 'Memory: its own. No other agent, and none of your own sessions, reads it.');
  assert.equal(memoryLine('codex'), 'Memory: off. Codex keeps one memory for everything it runs, so Postbox turns it off.');
  assert.equal(memoryLine('antigravity-cli'), 'Memory: none on this backend.');
  assert.equal(memoryLine('mock'), null);
});

test('#480 Kiro’s line follows its setup: isolated, memory is off; with your setup, it’s yours', () => {
  assert.equal(memoryLine('kiro-cli', { usesHostSetup: false }), 'Memory: off. Isolated agents share one Kiro home, so Postbox turns it off there.');
  assert.equal(memoryLine('kiro-cli', { usesHostSetup: true }), 'Memory: yours. With your setup, it reads and adds to your own Kiro memory.');
});
