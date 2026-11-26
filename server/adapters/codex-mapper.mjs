// Reads a Codex app-server turn’s notifications into the harness-event contract (server/harness-events.mjs), for the
// Codex adapter (codex.mjs). Moved out of codex.mjs.

import { HarnessEvents } from '../harness-events.mjs';
import { itemCompleted, itemStarted } from './codex-events.mjs';
import { codexContextPercent } from './context-usage.mjs';
import { codexQuota, emitQuota } from './quota-windows.mjs';
import { effortOf } from './setup.mjs';

export const codexEffortOf = (persona) => (effortOf(persona) === 'max' ? 'xhigh' : effortOf(persona));

export const errorText = (x) => x?.error?.message ?? x?.message ?? 'Codex app-server failed.';

/**
 * Reads app-server notifications into the harness-event contract (server/harness-events.mjs). io.lines: the harness’s
 * line reader, whose close ends the turn’s open messages; io.read: a file’s text,
 * for what a change replaced (codex-events.mjs).
 */
export function createCodexMapper(ctx, io = {}) {
  const emit = new HarnessEvents(ctx).event;
  const streamed = new Set(); // messages whose visible text arrived as deltas
  const held = new Map(); // a message’s leading whitespace-only deltas, held until it has visible text (#1543)
  const open = new Set(); // streamed messages not yet completed: their text is open (#1293)
  const push = (msg) => {
    const p = msg?.params ?? {};
    switch (msg?.method) {
      case 'item/started':
        itemStarted(emit, p.item);
        break;
      case 'item/completed':
        if (p.item?.type === 'agentMessage') {
          held.delete(p.item.id);
          if (p.item.text && !streamed.has(p.item.id)) emit({ kind: 'text', text: p.item.text, block: p.item.id });
          else if (open.delete(p.item.id)) emit({ kind: 'text_end', block: p.item.id });
        } else itemCompleted(emit, p.item, io.read);
        break;
      case 'item/agentMessage/delta':
        if (typeof p.delta !== 'string') break;
        // Only visible text marks a message streamed, or an empty or blank delta would hide its completed text
        // (#1543). Blank deltas before it are held, and go out with it, so a streamed reply keeps its whitespace.
        if (!streamed.has(p.itemId) && !/\S/.test(p.delta)) {
          held.set(p.itemId, (held.get(p.itemId) ?? '') + p.delta);
          break;
        }
        streamed.add(p.itemId);
        open.add(p.itemId);
        // Open until its item completes: two agent messages can stream at once, narrating parallel calls (#1293).
        emit({ kind: 'text', text: (held.get(p.itemId) ?? '') + p.delta, block: p.itemId, open: true });
        held.delete(p.itemId);
        break;
      case 'item/commandExecution/outputDelta':
        if (p.itemId) emit({ kind: 'tool_output', id: p.itemId, text: String(p.delta ?? '') });
        break;
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? p.token_usage;
        const last = u?.last ?? u?.total ?? {};
        emit({
          kind: 'context',
          percent: codexContextPercent(last.inputTokens ?? last.input_tokens ?? 0, u?.modelContextWindow ?? u?.model_context_window ?? null),
        });
        break;
      }
      case 'turn/started':
        emit({ kind: 'status', state: 'think' });
        break;
      case 'turn/completed': {
        const status = p.turn?.status;
        if (p.turn?.model) ctx.reported?.({ model: p.turn.model, effort: p.turn.effort ?? codexEffortOf(ctx.persona) });
        if (p.turn?.id) ctx.checkpoint?.({ turnId: p.turn.id, threadId: ctx.state.codexThreadId });
        emit({ kind: 'turn_end', isError: status === 'failed' });
        return { completed: true, status };
      }
      case 'account/rateLimits/updated':
        emitQuota(emit, codexQuota(p.rateLimits)); // the quota’s usage, for the composer’s quota line (#442)
        break;
      case 'error':
        // Out of quota (#442). The error doesn’t say which rate limit window ran out, so no reset time here; the
        // windows’ figures reach the quota line from account/rateLimits/updated.
        return p.error?.codexErrorInfo === 'usageLimitExceeded' ? { error: errorText(p), quota: { until: null } } : { error: errorText(p) };
      default:
        break;
    }
    return null;
  };
  /**
   * The turn ended however it did: every message still open ends with it, so the words another one held back reach the
   * reply rather than being lost with the turn (#1293). Stop’s abort runs this before deliver’s own listener, while the
   * turn still takes text; a crash, a failure or any other end closes the harness’s lines in deliver’s finally.
   */
  const end = () => {
    for (const id of open) emit({ kind: 'text_end', block: id });
    open.clear();
  };
  if (ctx.signal instanceof EventTarget) ctx.signal.addEventListener('abort', end, { once: true }); // a turn’s; a test’s context may have none
  io.lines?.on('close', end);
  return { push, end };
}
