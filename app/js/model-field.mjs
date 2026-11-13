// The Model field of the agent and persona sheets: a text field, with the backend’s models as suggestions. The
// suggestions are asked of the backend’s own harness when the field opens (POST /api/backends/:id/models, see
// server/model-lists.mjs), and whatever the person types goes to the harness as its --model.

import { BACKENDS, codexDefault, effortNamedBy, GEMINI_MODEL, modelDefault, modelName } from '/shared/agent-facts.mjs';
import { api, client } from './client.mjs';
import { h } from './dom.mjs';

/** What a backend can do (server/adapters/adapter.mjs, capabilities), as /api/state serves it (#117). */
export const capsOf = (backend) => client.config.backends?.[backend] ?? {};
/** The models to suggest for a backend: the last its harness listed, else Gemini’s on Antigravity, else none. */
export const modelsFor = (backend) => capsOf(backend).models ?? (backend === 'antigravity-cli' ? [GEMINI_MODEL] : []);

/**
 * Asks the backend’s harness for its models, once per backend while the sheet is open, and paints when it answers.
 * A model Postbox picked as the default (st.modelDefaulted) follows the list; one the person typed or saved never
 * changes. A backend that runs only on a host has no harness here to ask.
 * @param {any} st @param {() => void} paint
 */
function askModels(st, paint) {
  const backend = st.backend;
  st.modelLists ??= {};
  if (Object.hasOwn(st.modelLists, backend) || !capsOf(backend).local) return;
  st.modelLists[backend] = null;
  api(`/api/backends/${encodeURIComponent(backend)}/models`, {}).then(
    (r) => {
      const models = Array.isArray(r?.models) ? r.models : [];
      st.modelLists[backend] = { models, fresh: r?.fresh === true };
      const caps = client.config.backends?.[backend];
      if (caps && models.length) caps.models = models;
      if (st.backend === backend && st.modelDefaulted && models.length && !models.includes(st.model)) {
        st.model = modelDefault(backend, client.config);
        st.effort = effortNamedBy(backend, st.model) ?? st.effort;
      }
      paint();
    },
    () => {
      st.modelLists[backend] = { models: modelsFor(backend), fresh: false };
      paint();
    },
  );
}

/** What the field says about where its suggestions came from, or null when the harness listed them just now. */
function listHelp(st) {
  const name = BACKENDS.find(([id]) => id === st.backend)?.[1] ?? st.backend;
  const list = st.modelLists?.[st.backend];
  if (list === undefined || list?.fresh) return null;
  if (list === null) return `Asking ${name} for its models…`;
  return list.models.length
    ? `${name} didn’t list its models just now, so these are the ones it listed last. Any model you type goes to it as --model.`
    : `${name} didn’t list its models, so type the one you want: it goes to ${name} as --model.`;
}

/**
 * The field for st.model. idp prefixes element ids.
 * @param {any} st @param {() => void} paint @param {{ idp: string }} opts
 */
export function modelField(st, paint, { idp }) {
  askModels(st, paint);
  const help = listHelp(st);
  return h(
    'div.field',
    h('label.label', { for: `${idp}-m` }, 'Model'),
    h('input.input.mono', {
      id: `${idp}-m`,
      value: st.model,
      list: `${idp}-models`,
      spellcheck: 'false',
      'aria-describedby': help ? `${idp}-m-help` : null,
      oninput: (e) => {
        st.model = e.target.value.trim();
        st.modelDefaulted = false;
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
    help ? h('span.help', { id: `${idp}-m-help`, 'data-model-help': '' }, help) : null,
    // Codex picks its own model for `auto`: it isn’t one of Claude’s.
    st.backend === 'codex' ? h('span.help', 'auto is Codex’s default: the model your Codex configuration picks.') : null,
  );
}
