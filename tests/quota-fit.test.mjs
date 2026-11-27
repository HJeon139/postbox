// The names the quota line’s bars show (#442, app/js/quota-fit.mjs): each distinct, with the shortest start of a host’s
// name that tells two bars of one backend apart, never ending in a hyphen or a dot.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageModule } from './page-module.mjs';

const { fitBars, namesAt } = await pageModule('quota-fit.mjs');

const bar = (backend, full, host = null) => ({ backend, full, host });

test('bars of different backends keep their names, full or short', () => {
  const bars = [bar('claude-code', 'Claude Code'), bar('kiro-cli', 'Kiro CLI'), bar('codex', 'Codex')];
  assert.deepEqual(namesAt(bars, false), ['Claude Code', 'Kiro CLI', 'Codex']);
  assert.deepEqual(namesAt(bars, true), ['Claude', 'Kiro', 'Codex']);
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

/** Every character 6 px wide. */
const measure = (text) => text.length * 6;
const two = [
  { ...bar('claude-code', 'Claude Code'), pct: '42%' },
  { ...bar('codex', 'Codex'), pct: '7%' },
];

test('the track sits above the words, so it never costs a bar its full name', () => {
  // Each bar gets 94 px; “Claude Code 42%” is 90 px, with no room for a track beside it (#1463).
  assert.deepEqual(fitBars(two, 200, measure), { level: 0, names: ['Claude Code', 'Codex'] });
});

test('bars too narrow for their full names go short, then show their percent alone', () => {
  assert.deepEqual(fitBars(two, 150, measure), { level: 1, names: ['Claude', 'Codex'] });
  assert.deepEqual(fitBars(two, 80, measure), { level: 2, names: ['', ''] });
});
