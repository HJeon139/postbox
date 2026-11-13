// Model ids as each harness lists them, in Postbox’s spelling: pure, so the laptop’s adapters and a host’s daemon
// (server/remote/host/harness-models.mjs) read a listing the same way.

/**
 * A model id as the CLI takes it in --model: claude-opus-5-5, or one with a context suffix such as claude-opus-5-5[1m].
 * It starts with a letter, a digit or _, never -, so no listing can put an option where --model’s value goes.
 */
const MODEL_ID = /^\w[\w.:[\]-]{0,79}$/;
/** The most model ids one listing gives. */
export const MAX_MODELS = 60;
/** Whether v is a model id a listing may give. @param {unknown} v */
export const isModelId = (v) => typeof v === 'string' && MODEL_ID.test(v);

/**
 * The ids in the CLI’s model rows (the SDK’s ModelInfo), in its order, once each and bounded. An alias row
 * (“default”, “opus”) counts as the id it resolves to, so a persona never names an alias your own settings decide (#60).
 * @param {unknown} rows
 * @returns {string[]}
 */
export function claudeModelIds(rows) {
  if (!Array.isArray(rows)) return [];
  const ids = rows.map((m) => m?.resolvedModel ?? m?.value).filter(isModelId);
  return [...new Set(ids)].slice(0, MAX_MODELS);
}

/**
 * A Postbox model id in Kiro’s spelling: Kiro writes the version with a dot (`kiro-cli chat --list-models`), so
 * claude-opus-5-5 is claude-opus-5.5. Anything else, such as auto or gpt-5.6-terra, passes as it is.
 */
export const kiroModel = (id) => String(id).replace(/^(claude-[a-z]+-\d+)-(\d+)$/, '$1.$2');
/** The reverse, for what the run reports, so the model chip compares like with like; null for auto. */
export const postboxModel = (id) => (!id || id === 'auto' ? null : String(id).replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, '$1-$2'));

/** The model ids in a --list-models answer, bounded; auto keeps its name. */
export function kiroModelIds(json) {
  try {
    const list = JSON.parse(json)?.models;
    if (!Array.isArray(list)) return [];
    const ids = list.map((m) => m?.model_id).filter(isModelId);
    return [...new Set(ids.map((id) => postboxModel(id) ?? id))].slice(0, MAX_MODELS);
  } catch {
    return [];
  }
}
