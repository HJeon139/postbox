// What a Kiro session_info_update says (_meta.kiro): context use, a turn’s start, a tool approval Kiro would have
// asked and how it was resolved, the steering files it loaded, and an error Kiro shows, such as an MCP server that
// failed to start (#489). Moved out of kiro-cli.mjs’s mapper.

import { reportDisplayError } from './kiro-display-error.mjs';

/**
 * @param {any} k  the update’s _meta.kiro
 * @param {{ asked: Map<string, string>, refused: Set<string>, steering: string[] }} st  the mapper’s state
 * @param {{ ctx: any, contextUsed: (pct: unknown) => void, status: (s: { state: string, currentStep: string }) => void }} on
 */
export function sessionInfo(k, st, { ctx, contextUsed, status }) {
  if (k?.kind === 'context_usage') contextUsed(k.usagePercentage);
  else if (k?.kind === 'turn_start') status({ state: 'think', currentStep: 'Thinking' });
  else if (k?.kind === 'pending_interaction' && k.interactionType === 'tool_approval' && k.toolCallId) st.asked.set(k.toolCallId, String(k.question ?? ''));
  // lint-allow spelling: Kiro’s value.
  else if (k?.kind === 'interaction_resolved' && k.outcome === 'cancelled' && st.asked.has(k.toolCallId)) st.refused.add(k.toolCallId);
  else if (k?.kind === 'steering_inclusion' && Array.isArray(k.steeringDocuments)) st.steering = k.steeringDocuments.map(String);
  else if (k?.kind === 'display_error') reportDisplayError(ctx, k);
}
