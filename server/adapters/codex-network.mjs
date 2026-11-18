// In Auto, a Codex persona that may fetch the web also gets network access for shell commands (#324).
// Codex’s hosted search has its own setting, separate from the shell sandbox.

/** @param {any} persona */
const mayFetchWeb = (persona) => Array.isArray(persona?.tools) && persona.tools.includes('web.fetch');

/** @param {any} persona */
export const networkOn = (persona) => (persona?.permissionMode ?? 'auto') === 'auto' && mayFetchWeb(persona);

/** @param {any} persona */
export function codexWebSearchArgs(persona) {
  if (persona?.permissionMode === 'bypass' || mayFetchWeb(persona)) return [];
  return ['-c', 'web_search="disabled"'];
}
