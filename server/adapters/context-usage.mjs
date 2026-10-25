// Context window resolution and active context usage percentage calculation across backends.

/**
 * Context window sizes from official model documentation / model cards:
 * - Gemini 1.5 Pro, 2.5 Pro: 2,000,000 tokens (Google AI Gemini model cards).
 * - Gemini 1.5 Flash, 2.0 Flash, 3.8 Flash: 1,000,000 tokens (Google AI Gemini model cards).
 * Models not listed here return null so no percentage is guessed.
 */
const CITED_AGY_WINDOWS = /** @type {[RegExp, number][]} */ ([
  [/^gemini-(?:1\.5-pro|2\.5-pro)/, 2_000_000],
  [/^gemini-(?:1\.5-flash|2\.0-flash|3\.8-flash(?:-low|-medium|-high)?)/, 1_000_000],
]);

/** The cited context window for a Gemini model, or null if unlisted. */
export const agyWindowFor = (model) => CITED_AGY_WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? null;

/**
 * The active context percentage for an Antigravity step.
 * In Antigravity CLI usage reporting, total_tokens = input_tokens + output_tokens, meaning
 * input_tokens counts only uncached prompt tokens and cache_read_tokens counts cached prompt tokens.
 * Together, input_tokens + cache_read_tokens represent the full prompt context loaded into the model.
 */
export function agyContextPercent(usage, window) {
  if (!usage || typeof window !== 'number' || window <= 0) return null;
  const input = usage.input_tokens ?? 0;
  const cached = usage.cache_read_tokens ?? 0;
  const used = input + cached;
  if (used <= 0) return null;
  return Math.min(100, Math.round((used / window) * 100));
}

/**
 * The active context percentage for a Codex turn from thread/tokenUsage/updated.
 * Codex reports tokenUsage.modelContextWindow directly. When null or omitted, no percentage is shown.
 * tokenUsage.last.inputTokens represents active prompt context (cachedInputTokens is a subset of inputTokens).
 */
export function codexContextPercent(inputTokens, window) {
  if (typeof inputTokens !== 'number' || typeof window !== 'number' || window <= 0 || inputTokens <= 0) return null;
  return Math.min(100, Math.round((inputTokens / window) * 100));
}
