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
export const BACKENDS = [
  ['claude-code', 'Claude Code', 'Runs the claude CLI you’re signed in to.'],
  ['agent-sdk', 'Agent SDK', 'Runs the Claude Agent SDK in Postbox’s server.'],
  ['kiro-cli', 'Kiro CLI', 'Runs the kiro-cli you’re signed in to. It can’t ask you: what would need asking is refused.'],
  ['antigravity-cli', 'Antigravity CLI', 'Runs the agy CLI you’re signed in to, with Gemini models. It can’t ask you: what would need asking is refused.'],
  ['codex', 'Codex', 'Runs the Codex app-server with your local Codex sign-in and configuration.'],
  ['mock', 'Mock agent', 'Scripted replies for trying Postbox out.'],
];
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
/** The model an Antigravity CLI persona runs when it names none, and when the CLI didn’t report its list (#143). */
export const AGY_DEFAULT_MODEL = 'gemini-3.8-flash-high';
export const GEMINI_MODEL = AGY_DEFAULT_MODEL;
export const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const PERMISSIONS = [
  ['auto', 'Auto', 'A safety check approves routine actions; it asks you only when it can’t decide.'],
  ['ask', 'Ask me', 'It asks before running commands or changing files.'],
  ['acceptEdits', 'Accept edits', 'It edits files in its folders freely, and asks before running commands.'],
  ['bypass', 'Run everything', 'It never asks. Use it only in a folder you can lose.'],
];
const BACKEND_MODES = /** @type {Record<string, Record<string, string>>} */ ({
  'kiro-cli': {
    auto: 'Kiro has no safety check, so this is Ask me: it reads in its folders and runs a few read-only commands, such as git status, and refuses the rest.',
    ask: 'It reads in its folders and runs a few read-only commands, such as git status, and refuses the rest: it can’t ask you.',
    acceptEdits: 'It edits files in its folders freely, and refuses commands that would need asking.',
  },
  'antigravity-cli': {
    auto: 'It reads and edits files in its folders freely, and asks with a card before commands, edits outside its folders, and web fetches.',
    ask: 'It reads in its folders, and asks with a card before edits, commands, reads outside its folders, and web fetches.',
    acceptEdits: 'It reads and edits files in its folders freely, and asks with a card before commands, edits outside its folders, and web fetches.',
  },
  codex: {
    auto: 'Codex’s Auto: Codex’s own reviewer approves or denies what its sandbox stops, including writes through MCP tools and gh, instead of asking you. Its workspace-write sandbox, with network access off, still applies: this isn’t Run everything.',
    ask: 'Codex uses a read-only sandbox. It requests approval before a command can go beyond it.',
    acceptEdits: 'Codex uses a workspace-write sandbox with network access off; requests outside it need approval.',
    bypass: 'Codex runs with full filesystem and network access and no approval prompts.',
  },
});
/** The effort an Antigravity model id names (gemini-3.8-flash-high runs at high), or null (server/adapters/antigravity-cli.mjs). */
export const effortNamedBy = (backend, model) => (backend === 'antigravity-cli' ? (/-(low|medium|high)$/.exec(String(model ?? ''))?.[1] ?? null) : null);
/** What a permission mode means on a backend: its own words where it reads the modes differently. */
export const modeHelp = (backend, [id, , help]) => BACKEND_MODES[backend]?.[id] ?? help;
export const MCP_STATUS = {
  connected: 'Connected',
  failed: 'Couldn’t connect',
  'needs-auth': 'Needs sign-in',
  pending: 'Starting',
  disabled: 'Turned off in your Claude Code settings',
  'not-started': 'Not started yet',
};
export const MCP_SCOPE = {
  user: 'your settings',
  project: 'this project',
  local: 'your settings for this folder',
  plugin: 'plugin',
  'claude.ai': 'claude.ai connector',
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

/** Why a boilerplate can’t be picked on this computer, or null when its backend is available. */
export function boilerplateUnavailable(b, config = {}) {
  if (!b?.backend || (config?.adapters ?? []).includes(b.backend)) return null;
  return `${BACKEND_NAMES[b.backend] ?? b.backend} not on this computer`;
}

/** The models a backend is known to offer, or null when the backend didn’t report a catalog. */
const offeredBy = (id, config) =>
  config?.backends?.[id]?.models ?? (id === 'claude-code' || id === 'agent-sdk' ? MODELS : id === 'antigravity-cli' ? [GEMINI_MODEL] : null);

/** The default model for a backend when switching to it from an incompatible model. */
const defaultFor = (id, config) => {
  const offered = offeredBy(id, config);
  if (id === 'claude-code' || id === 'agent-sdk') return config?.defaultModel ?? MODELS[0];
  if (Array.isArray(offered) && offered.length) return offered[0];
  return id === 'antigravity-cli' ? GEMINI_MODEL : (config?.defaultModel ?? MODELS[0]);
};

/**
 * Switches a sheet’s backend, resetting st.model and st.effort when the new backend doesn’t offer the current model.
 * @param {any} st @param {string} id @param {any} [config]
 */
export function selectBackend(st, id, config = {}) {
  const prev = st.backend;
  st.bpFromBackend = false;
  st.backend = id;
  const offered = offeredBy(id, config);
  const prevOffered = prev === 'antigravity-cli' ? offeredBy(prev, config) : null;
  const incompatible = Array.isArray(offered)
    ? !offered.includes(st.model)
    : Boolean(prev && prev !== id && Array.isArray(prevOffered) && prevOffered.includes(st.model));
  if (id !== 'mock' && (!st.model || st.model === 'mock' || incompatible)) {
    st.model = defaultFor(id, config);
    st.effort = effortNamedBy(id, st.model) ?? config?.defaultEffort ?? 'medium';
  } else {
    st.effort = effortNamedBy(id, st.model) ?? st.effort;
  }
}

/**
 * Applies a boilerplate to the new-agent sheet’s state. A boilerplate that names a backend (such as Gemini on
 * the Antigravity CLI) selects that backend when it’s available on this computer, and prefers the boilerplate’s
 * model when offered, then the first gemini-* model for Antigravity or first reported model for Codex, then the boilerplate’s model. Picking a
 * generic boilerplate after a backend-bound one restores the default backend, model and effort.
 * @param {any} st @param {any} b @param {any} [config]
 */
export function applyBoilerplate(st, b, config = {}) {
  if (boilerplateUnavailable(b, config)) return false;
  const prevFromBp = st.bpFromBackend === true;
  st.bp = b.id;
  st.instructions = b.instructions ?? '';
  st.description = b.description ?? '';
  st.tools = new Set(b.tools ?? []);
  const adapters = config?.adapters ?? [];
  if (b.backend && adapters.includes(b.backend)) {
    st.bpFromBackend = true;
    st.backend = b.backend;
    const offered = config?.backends?.[b.backend]?.models;
    const list = Array.isArray(offered) ? offered : [];
    const preferred = b.backend === 'codex' ? list[0] : list.find((m) => /^gemini-/.test(m));
    st.model = (b.model && list.includes(b.model) ? b.model : preferred) ?? b.model ?? config?.defaultModel ?? MODELS[0];
    st.effort = effortNamedBy(st.backend, st.model) ?? config?.defaultEffort ?? 'medium';
  } else if (prevFromBp) {
    const def = BACKENDS.map(([id]) => id).find((id) => adapters.includes(id)) ?? 'mock';
    selectBackend(st, def, config);
  }
  return true;
}
