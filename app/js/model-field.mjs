// The Model field of the agent and persona sheets: a text field, with the backend’s models as suggestions. The
// suggestions are asked of the backend’s own harness when the field opens (POST /api/backends/:id/models, see
// server/model-lists.mjs): this computer’s, or, for an agent that runs on a host, the host’s (#1304). Whatever the
// person types goes to the harness as its --model.

import { BACKENDS, codexDefault, effortNamedBy, GEMINI_MODEL, modelDefault, modelName } from '/shared/agent-facts.mjs';
import { api, client } from './client.mjs';
import { h } from './dom.mjs';

/** What a backend can do (server/adapters/adapter.mjs, capabilities), as /api/state serves it (#117). */
export const capsOf = (backend) => client.config.backends?.[backend] ?? {};
/** The models to suggest for a backend: the last its harness listed, else Gemini’s on Antigravity, else none. */
export const modelsFor = (backend) => capsOf(backend).models ?? (backend === 'antigravity-cli' ? [GEMINI_MODEL] : []);

/** Where the suggestions come from: the backend here, or on the host the agent runs on (st.remote). */
const sourceOf = (st) => (st.remote ? `${st.backend}@${st.remote}` : st.backend);
/** The models to suggest: the host’s for an agent that runs on one, else this computer’s. */
const suggested = (st) => (st.remote ? (st.modelLists?.[sourceOf(st)]?.models ?? []) : modelsFor(st.backend));

/**
 * Asks the backend’s harness for its models, here or on the agent’s host, once per source while the sheet is open,
 * and paints when it answers. A model Postbox picked as the default (st.modelDefaulted) follows the list; one the
 * person typed or saved never changes. A backend only on a host has no harness here to ask until a host is picked.
 * @param {any} st @param {() => void} paint
 */
function askModels(st, paint) {
  const backend = st.backend;
  const hostId = st.remote ?? null;
  const source = sourceOf(st);
  st.modelLists ??= {};
  if (Object.hasOwn(st.modelLists, source) || (!hostId && !capsOf(backend).local)) return;
  st.modelLists[source] = null;
  api(`/api/backends/${encodeURIComponent(backend)}/models`, { hostId }).then(
    (r) => {
      const models = Array.isArray(r?.models) ? r.models : [];
      st.modelLists[source] = { models, fresh: r?.fresh === true, why: r?.why ?? null };
      const caps = client.config.backends?.[backend];
      if (!hostId && caps && models.length) caps.models = models;
      if (sourceOf(st) === source && st.modelDefaulted && models.length && !models.includes(st.model)) {
        st.model = modelDefault(backend, client.config, models);
        st.effort = effortNamedBy(backend, st.model) ?? st.effort;
      }
      paint();
    },
    () => {
      st.modelLists[source] = { models: hostId ? [] : modelsFor(backend), fresh: false, why: null };
      paint();
    },
  );
}

/**
 * What the field can say about where its suggestions came from, for the current backend and host: each message, and
 * the one it says now, or null when the harness listed them just now.
 * @returns {{ shown: string | null, all: string[] }}
 */
function listHelp(st) {
  const name = BACKENDS.find(([id]) => id === st.backend)?.[1] ?? st.backend;
  const list = st.modelLists?.[sourceOf(st)];
  /** One message for each answer: listed none, or listed some before. @param {string} why */
  const either = (why, some, none) => ({ some: `${why}${some}`, none: `${why}${none}` });
  /** @type {Record<string, { some: string, none: string }>} */
  let answers;
  let asking;
  if (!st.remote) {
    asking = `Asking ${name} for its models…`;
    answers = {
      'not-listed': {
        some: `${name} didn’t list its models just now, so these are the ones it listed last. Any model you type goes to it as --model.`,
        none: `${name} didn’t list its models, so type the one you want: it goes to ${name} as --model.`,
      },
    };
  } else {
    const host = client.state.hosts?.[st.remote]?.name ?? 'the host';
    asking = `Asking ${name} on ${host} for its models…`;
    const some = '. These are the ones it listed last, and any model you type goes to it as --model.';
    const none = `. Type the model you want: it goes to ${name} there as --model.`;
    answers = {
      unreachable: either(`Postbox couldn’t reach ${host} to list ${name}’s models`, some, none),
      outdated: either(`Postbox on ${host} is older than this one and can’t list models; install this version there under Settings, Hosts`, some, none),
      'no-cli': either(`${name} wasn’t found on ${host}, so it couldn’t list its models`, some, none),
      'not-listed': either(`${name} on ${host} didn’t list its models`, some, none),
    };
  }
  const all = [asking, ...Object.values(answers).flatMap((a) => [a.some, a.none])];
  if (list === undefined || list?.fresh) return { shown: null, all };
  if (list === null) return { shown: asking, all };
  const answer = (Object.hasOwn(answers, list.why ?? '') ? answers[list.why] : null) ?? answers['not-listed'];
  return { shown: list.models.length ? answer.some : answer.none, all };
}

/**
 * The help under the field, in one place whose height never changes with the answer (#1327): every message it could
 * show for this backend and host sits in the same grid cell, only the one it says now showing, so the cell is as tall
 * as the tallest and the answer coming in moves nothing below it, Save included. Choosing another backend or host may
 * resize it, with the person’s own click.
 * @param {{ shown: string | null, all: string[] }} help @param {string} idp
 */
function helpSlot(help, idp) {
  return h(
    'span.help.held-help',
    help.all.map((text) =>
      text === help.shown ? h('span', { id: `${idp}-m-help`, 'data-model-help': '' }, text) : h('span', { 'aria-hidden': 'true' }, text),
    ),
  );
}

/**
 * The field for st.model. idp prefixes element ids.
 * @param {any} st @param {() => void} paint @param {{ idp: string }} opts
 */
export function modelField(st, paint, { idp }) {
  askModels(st, paint);
  const help = listHelp(st);
  const real = capsOf(st.backend).local || st.remote;
  return h(
    'div.field',
    h('label.label', { for: `${idp}-m` }, 'Model'),
    h('input.input.mono', {
      id: `${idp}-m`,
      value: st.model,
      list: `${idp}-models`,
      spellcheck: 'false',
      'aria-describedby': help.shown ? `${idp}-m-help` : null,
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
      suggested(st).map((m) => h('option', { value: m, label: codexDefault(st.backend, m) ? modelName(st.backend, m) : null })),
    ),
    real ? helpSlot(help, idp) : null,
    // Codex picks its own model for `auto`: it isn’t one of Claude’s.
    st.backend === 'codex' ? h('span.help', 'auto is Codex’s default: the model your Codex configuration picks.') : null,
  );
}
