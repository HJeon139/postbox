// Context window resolution and active context usage percentage calculation across backends.

/**
 * Context window sizes for models offered by agy (see `agy models`):
 * - Gemini 4 Argon: 1,000,000 tokens (https://ai.google.dev/gemini-api/docs/models)
 * Models not listed here (including Gemini 3.8 Flash, which reports no window size in documentation)
 * return null so context percentage is never guessed.
 */
const CITED_AGY_WINDOWS = /** @type {[RegExp, number][]} */ ([[/^gemini-4-argon(?:-low|-medium|-high)?/, 1_000_000]]);

/** The cited context window for a Gemini model, or null if unlisted. */
export const agyWindowFor = (model) => CITED_AGY_WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? null;

/**
 * The active context percentage for an Antigravity step.
 * In Antigravity CLI usage reporting, total_tokens = input_tokens + output_tokens, meaning
 * input_tokens counts only uncached prompt tokens and cache_read_tokens counts cached prompt tokens.
 * Together, input_tokens + cache_read_tokens represent the full prompt context loaded into the model.
 * Evidence recorded in ~/.gemini/antigravity-cli/brain/93aa5dd9-c75c-4c80-8b5a-206e898de577/.system_generated/logs/transcript.jsonl step 245:
 * input_tokens (2,787) + output_tokens (148) = 2,935 total_tokens, while cache_read_tokens is 23,525.
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
