// What an agent runs with, in words: its backend, the model that answered its last turn and the effort (#60).
// The sidebar’s agent rows (#105), the overview’s cards and the conversation and session menus all say it the same way,
// so this is plain data and text, with no DOM. A session runs with the model and effort in its snapshot
// (fixed when it started, or changed by a command), falling back to its persona’s; the server does the same
// (server/runtime.mjs, personaFor; server/adapters/setup.mjs, modelOf and effortOf).

export const BACKEND_NAMES = {
  'claude-code': 'Claude Code',
  'agent-sdk': 'Agent SDK',
  'kiro-cli': 'Kiro CLI',
  'antigravity-cli': 'Antigravity CLI',
  codex: 'Codex',
  mock: 'Mock agent',
};
const EFFORT_WORDS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };
const effortWord = (e) => (Object.hasOwn(EFFORT_WORDS, e) ? EFFORT_WORDS[e] : String(e));

/** A short name where it’s unambiguous: “claude-opus-5-5” is “Opus 5.5”. Anything else stays as it is. */
export function shortModel(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(String(id ?? ''));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : String(id ?? '');
}

/**
 * Whether a Codex agent is set to Codex’s own default: `auto` (server/adapters/setup.mjs, AUTO_MODEL), or a Claude
 * model kept from before Codex offered `auto`, which Codex ignores the same way (server/adapters/codex.mjs, modelArg).
 * @param {string} backend @param {unknown} id
 */
export const codexDefault = (backend, id) => backend === 'codex' && (!id || id === 'auto' || String(id).startsWith('claude-'));

/** A model’s name for a backend: Codex’s default reads as that, not as `auto` or a Claude model it doesn’t run. */
export function modelName(backend, id) {
  return codexDefault(backend, id) ? 'Codex’s default' : shortModel(id);
}

/**
 * Whether the model that answered is the one set. The setting can be what the CLI takes: an id with a context
 * suffix (“claude-opus-5-5[1m]”) or a family alias (“opus”), while the stream reports the bare id, so only a
 * different model counts as different.
 */
export function sameModel(answered, set) {
  const bare = (id) =>
    String(id ?? '')
      .replace(/\[[^\]]*\]$/, '')
      .trim()
      .toLowerCase();
  const a = bare(answered);
  const s = bare(set);
  if (a === s) return true;
  // A family alias is whichever model of that family Claude Code picks.
  return /^[a-z]+$/.test(s) && a.startsWith(`claude-${s}-`);
}

/**
 * @typedef {{ backend: string, mock: true } | { backend: string, mock: false, model: string, setModel: string, answered: boolean,
 *   modelDiffers: boolean, effort: string, setEffort: string, effortDiffers: boolean }} Facts
 */

/**
 * What a session runs with. Its backend is its persona’s, which a change reaches from the next turn; the model
 * is the one that answered the last turn (se.lastModel), else the one it’s set to; the effort is the one the last
 * turn started with (se.lastEffort), else the one it’s set to. Each says when it differs from the setting.
 * @param {any} se a session
 * @param {any} persona its persona, if it still exists
 * @param {{ defaultModel?: string, defaultEffort?: string }} config
 * @returns {Facts}
 */
export function runsWith(se, persona, config) {
  const backend = String(persona?.backend ?? se?.backend ?? 'mock');
  if (backend === 'mock') return { backend, mock: true };
  const snap = se?.personaSnapshot ?? {};
  const named = snap.model ?? persona?.model;
  const setModel = String(named && named !== 'mock' ? named : (config.defaultModel ?? ''));
  const setEffort = String(snap.effort ?? persona?.effort ?? config.defaultEffort ?? '');
  const last = typeof se?.lastModel === 'string' && se.lastModel ? se.lastModel : null;
  const lastEffort = typeof se?.lastEffort === 'string' && se.lastEffort ? se.lastEffort : null;
  return {
    backend,
    mock: false,
    model: last ?? setModel,
    setModel,
    answered: !!last,
    // Codex’s default is whichever model Codex picks, so the one that answered never differs from it.
    modelDiffers: !!last && !codexDefault(backend, setModel) && !sameModel(last, setModel),
    effort: lastEffort ?? setEffort,
    setEffort,
    effortDiffers: !!lastEffort && lastEffort !== setEffort,
  };
}

/** For an agent’s row in the sidebar, where room is short: “Opus 5.5”, or “Sonnet 5.5, not Opus 5.5” when it differs. */
export function chipModel(f) {
  if (f.mock) return '';
  return f.modelDiffers ? `${modelName(f.backend, f.model)}, not ${modelName(f.backend, f.setModel)}` : modelName(f.backend, f.model);
}
/** For the row: “medium effort”, or “high effort, set to medium” when the setting changed since. */
export function chipEffort(f) {
  if (f.mock) return '';
  return f.effortDiffers ? `${effortWord(f.effort)} effort, set to ${effortWord(f.setEffort)}` : `${effortWord(f.effort)} effort`;
}

/**
 * Everything at once, with full model ids, for the overview card and the menus:
 * “Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort”.
 */
export function factsText(f) {
  const backend = Object.hasOwn(BACKEND_NAMES, f.backend) ? BACKEND_NAMES[f.backend] : f.backend;
  if (f.mock) return `${backend} · scripted replies, not a model`;
  const model = f.modelDiffers ? `${f.model} · not the model you set: ${f.setModel}` : codexDefault(f.backend, f.model) ? 'Codex’s default' : f.model;
  const effort = f.effortDiffers ? `${effortWord(f.effort)} effort on the last turn, set to ${effortWord(f.setEffort)}` : `${effortWord(f.effort)} effort`;
  return `${backend} · ${model} · ${effort}`;
}

/**
 * The overview’s line when Postbox looked for Claude Code and didn’t find it (#12), or null: what agents run on
 * until it’s installed. It doesn’t show under --demo or POSTBOX_BACKENDS=mock, where Postbox doesn’t look.
 * @param {{ realBackends?: boolean, versions?: { claudeCode?: string|null }, adapters?: string[] }} config
 */
export function installNote({ realBackends, versions, adapters = [] }) {
  if (!realBackends || versions?.claudeCode) return null;
  return adapters.some((a) => a !== 'mock')
    ? 'Claude Code isn’t installed here, so agents run on the Agent SDK or the mock until it is.'
    : 'Claude Code isn’t installed here, so agents run on the mock until it is: scripted replies, not a model.';
}
