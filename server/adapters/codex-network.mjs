// Whether a Codex persona’s sandbox has network access (#324): in Auto, when it may fetch the web, as the person
// decided on 25 October 2026. Every other mode and persona stays offline. codexPermissions (codex.mjs) builds the
// sandbox from it, and codex-always.mjs reads it before offering a network host on a card.

/** @param {any} persona */
export const networkOn = (persona) => (persona?.permissionMode ?? 'auto') === 'auto' && Array.isArray(persona?.tools) && persona.tools.includes('web.fetch');
