// The Model field of the agent and persona sheets: a text field, with the backend’s models as suggestions.

import { codexDefault, effortNamedBy, GEMINI_MODEL, MODELS, modelName } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';

/** What a backend can do (server/adapters/adapter.mjs, capabilities), as /api/state serves it (#117). */
export const capsOf = (backend) => client.config.backends?.[backend] ?? {};
/** The models to suggest for a backend: the ones it reported, else Gemini’s on Antigravity or Claude’s. */
export const modelsFor = (backend) => capsOf(backend).models ?? (backend === 'antigravity-cli' ? [GEMINI_MODEL] : MODELS);

/**
 * The field for st.model. idp prefixes element ids.
 * @param {any} st @param {() => void} paint @param {{ idp: string }} opts
 */
export function modelField(st, paint, { idp }) {
  return h(
    'div.field',
    h('label.label', { for: `${idp}-m` }, 'Model'),
    h('input.input.mono', {
      id: `${idp}-m`,
      value: st.model,
      list: `${idp}-models`,
      spellcheck: 'false',
      oninput: (e) => {
        st.model = e.target.value.trim();
      },
      // A model that names its effort runs at it, so Effort follows (the Gemini room UAT: Medium beside
      // gemini-3.8-flash-high read as a contradiction).
      onchange: () => {
        const named = effortNamedBy(st.backend, st.model);
        if (named && named !== st.effort) {
          st.effort = named;
          paint();
        }
      },
    }),
    h(
      'datalist',
      { id: `${idp}-models` },
      modelsFor(st.backend).map((m) => h('option', { value: m, label: codexDefault(st.backend, m) ? modelName(st.backend, m) : null })),
    ),
    // Codex picks its own model for `auto`: it isn’t one of Claude’s.
    st.backend === 'codex' ? h('span.help', 'auto is Codex’s default: the model your Codex configuration picks.') : null,
  );
}
