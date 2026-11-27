// The prompt each backend gives a turn whose message is an `input` (#1427): turn-input.mjs’s text, which every backend
// formats as it is (formatMessage), with the room’s facts first, so a turn’s fixed parts lead in a stable order for the
// prompt cache (#515). Each backend builds its message as its adapter does (turnGuide with that adapter’s arguments;
// Codex puts a fresh session’s note before the text), and its prompt is kept in tests/fixtures/input-prompt/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FRESH_START_TEXT, formatMessage, turnGuide } from '../server/adapters/guide.mjs';
import { KIRO_TOOL_RULES } from '../server/adapters/kiro-cli-agent.mjs';

const TEXT = [
  '[Postbox] 1 message for you in this conversation. Your reply posts there.',
  '[it_1] The person, 09:30 UTC: @alpha compare the editions',
  '[Postbox] Also since your last turn, not addressed to you:',
  '[it_0] @beta: The index is rebuilt.',
].join('\n\n');

const persona = (backend) => ({ handle: 'alpha', backend, tools: {} });
const who = {
  handles: ['alpha', 'beta'],
  room: [
    { handle: 'alpha', role: 'Reviews.' },
    { handle: 'beta', role: 'Builds.' },
  ],
  project: { name: 'P' },
  session: {},
};

/** Each backend’s turn message for an input, as its adapter builds it. */
const BACKENDS = {
  'claude-code': () => turnGuide({ kind: 'input', text: TEXT }, { ...who, persona: persona('claude-code') }).message,
  'kiro-cli': () => turnGuide({ kind: 'input', text: TEXT }, { ...who, persona: persona('kiro-cli'), toolRules: KIRO_TOOL_RULES }).message,
  'antigravity-cli': () => turnGuide({ kind: 'input', text: TEXT }, { ...who, persona: persona('antigravity-cli'), toolRules: null, setup: false }).message,
  codex: () => {
    const message = turnGuide({ kind: 'input', text: TEXT }, { ...who, persona: persona('codex'), toolRules: null }).message;
    return { ...message, text: `[Postbox] ${FRESH_START_TEXT}\n\n${message.text}` };
  },
};

for (const [backend, message] of Object.entries(BACKENDS))
  test(`#1427 ${backend} gives an input turn its text, after the room’s facts`, () => {
    const prompt = formatMessage(message());
    const fixture = readFileSync(new URL(`fixtures/input-prompt/${backend}.txt`, import.meta.url), 'utf8');
    assert.equal(prompt, fixture.replace(/\n$/, ''));
    assert.ok(prompt.indexOf('[Postbox] What’s current in this room') < prompt.indexOf(TEXT), 'the facts lead');
  });
