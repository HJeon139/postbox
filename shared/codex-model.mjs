// One definition of Codex’s backend default for request overrides and model status.
export const CODEX_DEFAULT_LABEL = 'Codex’s default';

/** @param {unknown} model @param {string[]} offered @param {string} runtimeDefault */
export const codexUsesDefault = (model, offered, runtimeDefault) =>
  !model || model === 'mock' || ((model === runtimeDefault || (typeof model === 'string' && model.startsWith('claude-'))) && !offered.includes(String(model)));
