// Codex chooses its own default when the runtime supplies Claude’s fallback and Codex does not offer it.
import { codexUsesDefault } from '../../shared/codex-model.mjs';
import { DEFAULT_MODEL } from './setup.mjs';

export function codexModelOverride(persona, offered = []) {
  const model = persona?.model && persona.model !== 'mock' ? String(persona.model) : null;
  return codexUsesDefault(model, offered, DEFAULT_MODEL) ? {} : { model };
}
