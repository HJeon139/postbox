// Context window resolution and active context usage percentage calculation across backends.

/**
 * Context window sizes for models offered by agy (see `agy models`):
 * - Gemini 4 Argon: 1,000,000 tokens (https://ai.google.dev/gemini-api/docs/models)
 * - Gemini 3.8 Flash: 1,000,000 tokens
 * Models not listed here return null so context percentage is never guessed.
 */
const CITED_AGY_WINDOWS = /** @type {[RegExp, number][]} */ ([
  [/^gemini-4-argon(?:-low|-medium|-high)?/, 1_000_000],
  [/^gemini-3\.8-flash(?:-low|-medium|-high)?/, 1_000_000],
]);

/** Whether a token count a backend sent is usable: a finite number, not negative. JSON can carry 1e400, which is Infinity. */
const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** The cited context window for a Gemini model, or null if unlisted. */
export const agyWindowFor = (model) => CITED_AGY_WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? null;

/**
 * The active context percentage for an Antigravity step.
 * In Antigravity CLI usage reporting, total_tokens = input_tokens + output_tokens, meaning
 * input_tokens counts only uncached prompt tokens and cache_read_tokens counts cached prompt tokens.
 * Together, input_tokens + cache_read_tokens represent the full prompt context loaded into the model.
 * Recorded in tests/fixtures/antigravity-cli/error-after-refusal.jsonl, step 32: input_tokens (2,682) +
 * output_tokens (248) = 2,930 total_tokens, while cache_read_tokens is 20,545.
 * A count that isn’t a finite, non-negative number makes the percentage unknown, rather than one added as text or NaN.
 */
export function agyContextPercent(usage, window) {
  if (!usage || !isCount(window) || window <= 0) return null;
  const input = usage.input_tokens ?? 0;
  const cached = usage.cache_read_tokens ?? 0;
  if (!isCount(input) || !isCount(cached)) return null;
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
  if (!isCount(inputTokens) || !isCount(window) || window <= 0 || inputTokens <= 0) return null;
  return Math.min(100, Math.round((inputTokens / window) * 100));
}
