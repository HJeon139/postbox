// The model override sent to Codex thread and turn requests.
export const codexModelOf = (persona) => (persona?.model && persona.model !== 'mock' ? String(persona.model) : null);
