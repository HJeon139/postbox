// #480: the persona sheet says what each backend does with memory, in one line, as #208 and #479 left it, here and on
// a host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryLine } from '../shared/agent-memory.mjs';

const OWN = 'Memory: its own. No other agent, and none of your own sessions, reads it.';

test('#480 each backend’s memory line', () => {
  assert.equal(memoryLine('claude-code'), OWN);
  assert.equal(memoryLine('codex'), 'Memory: off. Codex keeps one memory for everything it runs, so Postbox turns it off.');
  assert.equal(
    memoryLine('antigravity-cli'),
    'Memory: if Antigravity keeps any, it’s your sign-in’s, shared with every Antigravity agent and your own sessions.',
  );
  assert.equal(memoryLine('mock'), null);
});

test('#480 Claude Code older than the one with a memory per agent shares one, on this computer', () => {
  assert.equal(
    memoryLine('claude-code', {}, { claudeCode: '2.1.70 (Claude Code)' }),
    'Memory: one for every agent in the project and your own sessions there, until Claude Code is 2.1.74 or later.',
  );
  assert.equal(memoryLine('claude-code', {}, { claudeCode: '2.1.74 (Claude Code)' }), OWN);
  // On a host, the host’s version decides, which the sheet doesn’t know; its memory is kept per agent there (#491).
  assert.equal(memoryLine('claude-code', { remote: 'ho_1' }, { claudeCode: '2.1.70' }), OWN);
});

test('#480 Kiro’s line follows its setup and where it runs', () => {
  assert.equal(memoryLine('kiro-cli', { usesHostSetup: false }), 'Memory: off. Isolated agents share one Kiro home, so Postbox turns it off there.');
  assert.equal(memoryLine('kiro-cli', { usesHostSetup: true }), 'Memory: yours. With your setup, it reads and adds to your own Kiro memory.');
  assert.equal(memoryLine('kiro-cli', {}), 'Memory: yours. With your setup, it reads and adds to your own Kiro memory.');
  assert.equal(
    memoryLine('kiro-cli', { usesHostSetup: false, remote: 'ho_1' }),
    'Memory: if Kiro keeps any, it’s in a Kiro home of its own on the host, kept under its name.',
  );
  assert.equal(memoryLine('kiro-cli', { usesHostSetup: true, remote: 'ho_1' }), 'Memory: the host account’s own Kiro memory, with your setup.');
});
