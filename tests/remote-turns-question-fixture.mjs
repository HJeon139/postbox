// The recorded AskUserQuestion prompts and the helpers the #1059 host-question tests share, moved from
// tests/remote-turns-question.test.mjs unchanged. The prompts are recorded (fixtures/claude-code/ask-user-question-prompts.json,
// Claude Code 2.1.319, #521). The call’s stream line is the recorded turn’s first tool call with AskUserQuestion in it,
// as tests/ask-question-cli.test.mjs builds it: no stream recorded on a host has this call.

import { readFileSync } from 'node:fs';
import { fixtureLines } from './fake-daemon.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8')).prompts;
export const ONE = RECORDED.find((p) => p.run === 'one-auto');
export const TWO = RECORDED.find((p) => p.run === 'two-auto');
export const request = (/** @type {any} */ p) => ({ tool_name: 'AskUserQuestion', input: p.input, tool_use_id: p.tool_use_id });

/** The stream’s line for the call. @param {any} p */
export function callLine(p) {
  const line = JSON.parse(fixtureLines().find((l) => l.startsWith('{"type":"assistant"') && l.includes('"tool_use"')) ?? '');
  line.message.content = [{ type: 'tool_use', id: p.tool_use_id, name: 'AskUserQuestion', input: p.input }];
  return JSON.stringify(line);
}

export const questions = (/** @type {any} */ r) => r.store.items(r.t.id).filter((/** @type {any} */ i) => i.kind === 'block' && i.question);
/** @param {any} q @param {string} label */
export const pick = (r, q, label) => r.rt.act(r.t.id, q.id, 'choose', { selected: [q.block.options.find((/** @type {any} */ o) => o.label === label).id] });
