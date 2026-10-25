// Context window resolution and active context usage percentage calculation across backends.

const AGY_WINDOWS = /** @type {[RegExp, number][]} */ ([
  [/^gemini-(?:1\.5-pro|2\.5-pro)/, 2_000_000],
  [/^gemini-/, 1_000_000],
]);

/** The context window for a Gemini model, or null if unknown. */
export const agyWindowFor = (model) => AGY_WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? null;

/** The active context percentage for an Antigravity step. */
export function agyContextPercent(usage, window) {
  if (!usage || typeof window !== 'number' || window <= 0) return null;
  const used = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
  return Math.min(100, Math.round((used / window) * 100));
}

const CODEX_WINDOWS = /** @type {[RegExp, number][]} */ ([
  [/^gpt-[56]/, 475_000],
  [/^gpt-4/, 128_000],
  [/^o[13]/, 200_000],
]);

/** Fallback context window for known Codex models when omitted in notifications. */
export const codexWindowFor = (model) => CODEX_WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? null;

/** The active context percentage for a Codex turn or notification. */
export function codexContextPercent(tokens, window) {
  if (!tokens || typeof window !== 'number' || window <= 0) return null;
  const input = tokens.inputTokens ?? tokens.input_tokens ?? 0;
  return Math.min(100, Math.round((input / window) * 100));
}
