// The names the quota line’s bars show (#442, app/js/quota-fit.mjs): each distinct, with the shortest start of a host’s
// name that tells two bars of one backend apart, never ending in a hyphen or a dot.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namesAt } from '../app/js/quota-fit.mjs';

const bar = (backend, full, host = null) => ({ backend, full, host });

test('bars of different backends keep their names, full or short', () => {
  const bars = [bar('claude-code', 'Claude Code'), bar('agent-sdk', 'Agent SDK'), bar('codex', 'Codex')];
  assert.deepEqual(namesAt(bars, false), ['Claude Code', 'Agent SDK', 'Codex']);
  assert.deepEqual(namesAt(bars, true), ['Claude', 'SDK', 'Codex']);
});

test('two bars of one backend get the shortest start of their hosts’ names that tells them apart', () => {
  assert.deepEqual(namesAt([bar('claude-code', 'Claude Code', 'workstation-1'), bar('claude-code', 'Claude Code', 'workstation-2')], true), [
    'Claude @workstation-1',
    'Claude @workstation-2',
  ]);
  assert.deepEqual(namesAt([bar('claude-code', 'Claude Code'), bar('claude-code', 'Claude Code', 'build-box')], true), ['Claude', 'Claude @b']);
});

test('a host’s start never ends in a hyphen, a dot or an underscore', () => {
  assert.deepEqual(namesAt([bar('codex', 'Codex', 'box-1'), bar('codex', 'Codex', 'box')], false), ['Codex @box-1', 'Codex @box']);
  assert.deepEqual(namesAt([bar('codex', 'Codex', 'lab.east'), bar('codex', 'Codex', 'lab.west')], false), ['Codex @lab.e', 'Codex @lab.w']);
});

test('hosts of one name can’t be told apart, so the level is passed over', () => {
  assert.equal(namesAt([bar('codex', 'Codex', 'box'), bar('codex', 'Codex', 'box')], false), null);
});
