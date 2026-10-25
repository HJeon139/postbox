// Codex chooses its own default when the runtime supplies Claude’s fallback and Codex does not offer it.
import { DEFAULT_MODEL } from './setup.mjs';

export function codexModelOverride(persona, offered = []) {
  const model = persona?.model && persona.model !== 'mock' ? String(persona.model) : null;
  return model && (model !== DEFAULT_MODEL || offered.includes(model)) ? { model } : {};
}
