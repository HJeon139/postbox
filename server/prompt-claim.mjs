// Which permission prompts count (#353, #665). permission_prompt is how the Claude Code CLI asks before a call
// (--permission-prompt-tool), but the turn’s token is in the CLI’s arguments, so a command the agent runs can post to
// /mcp too, with any tool_name and input. A prompt counts only when it’s for a call the turn’s stream showed, the
// agent’s own or a subagent’s, still waiting for its result, with that call’s name and input, and only once per call.
// Anything else is refused here, before a rule, the write judge or its budget (server/write-intent.mjs) sees it, and
// before any card. Every prompt lands here: the laptop’s (server/permission-prompt.mjs) and a host’s
// (server/remote/turns-prompts.mjs), whose stream the laptop reads too.

import { isDeepStrictEqual } from 'node:util';
import { PROMPT_CALL_WAIT_MS, PROMPT_HOLDS_MAX, PROMPT_REFUSAL_LINES } from '../shared/limits.mjs';
import { adapterOf } from './adapters/adapter.mjs';
import { describePermission } from './adapters/claude-stream.mjs';
import { heldPrompts, seenCall, whenSeen } from './turn-work.mjs';

/** What the agent is told when its prompt is refused, by why. */
export const REFUSED = Object.freeze({
  // Each reads true whoever sent the prompt: the CLI, for a call it’s about to make, or a command the agent ran.
  unseen:
    'Postbox didn’t ask the person: it saw no call of this turn with that tool_use_id waiting to run, so the call was denied. If you need it, make the call again.',
  differs:
    'Postbox didn’t ask the person: this prompt’s tool_name or input isn’t that of the call with that tool_use_id, so the call was denied. If you need it, make the call again.',
  answered: 'Postbox didn’t ask the person: the call with that tool_use_id already has its result.',
  again: 'Postbox already asked about the call with that tool_use_id, so a second answer for this call was refused.',
  ended: 'The turn has ended.',
  closed: 'The permission request closed before anyone answered.',
});

/** @typedef {keyof typeof REFUSED} Refusal */

/**
 * Claims the call a prompt is for. `by` names the prompt: a host sends its prompt again after a reconnect, and that
 * repeat is the same claim, not a second one; on the laptop each prompt is its own. Resolves to the call’s name and
 * input as the stream showed them, which the card draws, never the prompt’s, with the subagent’s call it was made under
 * (agentId: the stream’s, never the prompt’s agent_id, null for the agent’s own); to a refusal with what to answer; or
 * to a repeat, which the first of its kind answers.
 * @param {any} rt @param {string} sessionId @param {any} args  permission_prompt’s arguments
 * `ready`: what the wait for the call’s line waits on before its bound starts, a host stream’s replay
 * (server/remote/turns-replay.mjs), and `readyEnd` the most it waits on it: if that settles first, the prompt is
 * refused as `unseen`. The line still ends the wait at once.
 * @param {{ by?: unknown, signal?: AbortSignal | null, ready?: Promise<unknown> | null, readyEnd?: Promise<unknown> | null }} [o]
 * @returns {Promise<{ ok: true, tool: string, input: any, agentId?: string | null } | { ok: false, why: Refusal, message: string } | { ok: false, why: 'repeat' }>}
 */
export async function claimPrompt(rt, sessionId, args, { by = Symbol('prompt'), signal = null, ready = null, readyEnd = null } = {}) {
  const turn = rt.turns.get(sessionId);
  if (!turn) return refusal('ended');
  if (!asksForOwnCalls(rt, turn)) {
    const agentId = typeof args?.agent_id === 'string' ? args.agent_id : null;
    return { ok: true, tool: String(args?.tool_name ?? ''), input: args?.input ?? {}, agentId };
  }
  const id = args?.tool_use_id;
  // Each prompt that waits holds its request open: past PROMPT_HOLDS_MAX waiting in the turn, one more is refused at
  // once, as it would be at the bound.
  if (typeof id === 'string' && id && !seenCall(turn, id) && heldPrompts(turn) >= PROMPT_HOLDS_MAX) return refused(rt, turn, 'unseen', id);
  // The prompt can come before the stream’s line for its call: it waits for it, a short while.
  const call = typeof id === 'string' && id ? await whenSeen(turn, id, PROMPT_CALL_WAIT_MS, signal, ready, readyEnd) : null;
  if (signal?.aborted) return refusal('closed');
  if (rt.turns.get(sessionId) !== turn) return refusal('ended');
  if (!call) return refused(rt, turn, 'unseen', id);
  if (call.state === 'claimed') return call.by === by ? { ok: false, why: 'repeat' } : refused(rt, turn, 'again', id, call);
  if (call.state === 'answered') return refused(rt, turn, 'answered', id, call);
  if (args.tool_name !== call.name || !isDeepStrictEqual(args.input ?? {}, call.input)) return refused(rt, turn, 'differs', id, call, args);
  call.state = 'claimed';
  call.by = by;
  return { ok: true, tool: call.name, input: call.input, agentId: call.parent ?? null };
}

/**
 * Whether the turn’s prompts are its CLI’s own, for calls its stream shows: every backend that asks through
 * permission_prompt, except one whose prompts come from Postbox’s own hook (capabilities.promptHook, Antigravity’s),
 * by an id of the hook’s. An adapter that declares nothing is held to the stream.
 * @param {any} rt @param {any} turn
 */
function asksForOwnCalls(rt, turn) {
  return adapterOf(rt, turn.backend)?.capabilities?.promptHook !== true;
}

/** @param {Refusal} why */
const refusal = (why) => /** @type {const} */ ({ ok: false, why, message: REFUSED[why] });

/**
 * A refusal the person sees too, as a line in the conversation, one for each call a prompt named and why it was
 * refused, so a genuine prompt that’s refused always says so; up to PROMPT_REFUSAL_LINES a turn, then one line that
 * counts the rest. The line says nothing the prompt said: only the stream’s call, when the prompt named one, and for
 * one that differs from it, which part did, by the names of the input’s keys (escaped and clipped), never a value.
 * @param {any} rt @param {any} turn @param {Refusal} why @param {unknown} id @param {{ name: string, input: any }} [call]
 * @param {any} [args]  the prompt’s, for a `differs`
 */
function refused(rt, turn, why, id, call, args) {
  const shown = (turn.promptRefusals ??= { keys: new Set(), more: 0, moreId: null });
  const key = `${why}:${typeof id === 'string' ? id : ''}`;
  if (shown.keys.has(key)) return refusal(why);
  const handle = rt.s.sessions[turn.sessionId]?.handle ?? 'agent';
  const line = { kind: 'system', variant: 'prompt-refused', handle, turnId: turn.id };
  if (shown.keys.size < PROMPT_REFUSAL_LINES) {
    shown.keys.add(key);
    rt.addItem(turn.threadId, { ...line, text: lineText(why, handle, call, args) });
  } else {
    // Past the cap only a count is kept, so a flood of prompts holds nothing more than its number.
    shown.more += 1;
    const text = `${shown.more} more permission ${shown.more === 1 ? 'prompt' : 'prompts'} from @${handle} ${shown.more === 1 ? 'was' : 'were'} refused this turn, so nobody was asked.`;
    if (shown.moreId) rt.patchItem(turn.threadId, shown.moreId, { text });
    else shown.moreId = rt.addItem(turn.threadId, { ...line, text }).id;
  }
  return refusal(why);
}

/**
 * What the person reads for one refused prompt.
 * @param {Refusal} why @param {string} handle @param {{ name: string, input: any }} [call] @param {any} [args]
 */
function lineText(why, handle, call, args) {
  const named = call ? describePermission(call.name, call.input).summary : '';
  switch (why) {
    case 'again':
      return `@${handle}’s call was asked about already, so a second answer for this call was refused: ${named}`;
    case 'differs':
      return `Refused a permission prompt from @${handle}: it differed from the call it named (${named}) in ${call ? mismatch(args, call) : 'its input'}, so nobody was asked. If @${handle} needs that call, ask it to make it again.`;
    case 'answered':
      return `Refused a permission prompt from @${handle}: the call it named (${named}) already has its result, so nobody was asked.`;
    case 'unseen':
      return `Refused a permission prompt from @${handle}: it named no call of this turn waiting to run, so nobody was asked. If @${handle} needs that call, ask it to make it again.`;
    default:
      throw new Error(`No line for a prompt refused as ${why}.`);
  }
}

// ── Which part of a prompt differs from its call ─────────────────────────────────────────
// A PreToolUse hook (the person’s, the project’s or the organization’s) that rewrites a call’s input makes the CLI’s
// own prompt differ from the stream’s call, so the line says where: the tool’s name, or the input, by the keys whose
// values differ, are missing or are extra. A key is the agent’s or the CLI’s text, so each is clipped to KEY_CHARS and
// escaped (JSON’s escapes, and \u for anything but printable ASCII and for < > &), and at most SHOWN_KEYS are named.

const SHOWN_KEYS = 5;
const KEY_CHARS = 40;

/** @param {any} args @param {{ name: string, input: any }} call */
function mismatch(args, call) {
  const parts = [];
  if (args?.tool_name !== call.name) parts.push('its tool name');
  const input = args?.input ?? {};
  if (!isDeepStrictEqual(input, call.input)) parts.push(inputPart(input, call.input));
  return parts.join(' and in ');
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} input @param {unknown} wanted */
function inputPart(input, wanted) {
  if (!isRecord(input) || !isRecord(wanted)) return 'its whole input';
  const keys = [...new Set([...Object.keys(wanted), ...Object.keys(input)])].filter(
    (k) => !Object.hasOwn(input, k) || !Object.hasOwn(wanted, k) || !isDeepStrictEqual(input[k], wanted[k]),
  );
  if (!keys.length) return 'its whole input';
  const named = keys.slice(0, SHOWN_KEYS).map(quoteKey);
  const more = keys.length - named.length;
  if (more) named.push(`${more} more ${more === 1 ? 'key' : 'keys'}`);
  return `its input at ${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]}`;
}

/** A key as the line shows it: in quotes, clipped, escaped. @param {string} k */
function quoteKey(k) {
  const chars = Array.from(k);
  const inner = JSON.stringify(chars.slice(0, KEY_CHARS).join(''))
    .slice(1, -1)
    .replace(/[^\x20-\x7e]|[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${inner}${chars.length > KEY_CHARS ? '…' : ''}"`;
}
