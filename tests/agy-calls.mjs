// Antigravity’s PreToolUse hook as a turn runs it, for the tests that post its prompts (#907): a prompt counts only for
// a call the turn’s stream showed, so each test shows its call as agy’s stream does (hook-stream.jsonl: a tool step,
// ACTIVE, with its parameters), and the hook names it by its step, as agy’s hook event carries it (hook-event.json).

import { AntigravityCliAdapter, createAgyMapper } from '../server/adapters/antigravity-cli.mjs';

export const CONVERSATION = 'c1a2b3c4-0000-4000-8000-000000000000';
/** The id the stream gives the call of step `stepIdx` (antigravity-cli.mjs’s stepId). @param {number} stepIdx */
export const callId = (stepIdx) => `agy-${CONVERSATION.slice(0, 8)}-${stepIdx}`;

/** The real adapter’s card for its hook’s prompts, for a test adapter to declare. @param {any} call @param {any} args */
export const promptCard = (call, args) => AntigravityCliAdapter.prototype.promptCard.call(null, call, args);

/** @type {WeakMap<object, ReturnType<typeof createAgyMapper>>} */
const mappers = new WeakMap();
/**
 * Shows the call of step `stepIdx` in the turn’s stream, through the real parser, waiting to run.
 * @param {any} ctx  the turn’s context @param {number} stepIdx @param {string} name @param {Record<string, unknown>} parameters
 */
export function showCall(ctx, stepIdx, name, parameters) {
  if (!mappers.has(ctx)) mappers.set(ctx, createAgyMapper(ctx));
  const step = { conversation_id: CONVERSATION, step_index: stepIdx, state: 'ACTIVE', step_type: 'tool', tool_name: name };
  mappers.get(ctx)?.push({ event: 'step_update', step_update: { ...step, tool_info: { name, parameters } } });
}

/** The hook’s stdin for the call of step `stepIdx`. @param {number} stepIdx @param {string} name @param {Record<string, unknown>} args */
export const hookEvent = (stepIdx, name, args) => JSON.stringify({ conversationId: CONVERSATION, stepIdx, toolCall: { name, args } });
