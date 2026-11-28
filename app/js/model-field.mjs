// The Model field of the agent and persona sheets: a text field, with the backend’s models as suggestions. The
// suggestions are asked of the backend’s own harness when the field opens (POST /api/backends/:id/models, see
// server/model-lists.mjs): this computer’s, or, for an agent that runs on a host, the host’s (#1304). Whatever the
// person types goes to the harness as its --model. A harness lists the models it knows, not the ones this sign-in may
// run, so the suggestions are ordered by how each one’s last turn there ended, and the field says so for the model in
// it (#1977, shared/model-ran.mjs).

import { BACKENDS, codexDefault, effortNamedBy, modelDefault, modelName } from '/shared/agent-facts.mjs';
import { byRan, ranDefault, ranWords } from '/shared/model-ran.mjs';
import { api, client } from './client.mjs';
import { ago, h } from './dom.mjs';

/** What a backend can do (server/adapters/adapter.mjs, capabilities), as /api/state serves it (#117). */
export const capsOf = (backend) => client.config.backends?.[backend] ?? {};
/** The models to suggest for a backend: the last its harness listed, else its preferred model (Antigravity’s Gemini), else none. */
export const modelsFor = (backend) => capsOf(backend).models ?? (capsOf(backend).preferModel ? [capsOf(backend).preferModel.id] : []);

/** Where the suggestions come from: the backend here, or on the host the agent runs on (st.remote). */
const sourceOf = (st) => (st.remote ? `${st.backend}@${st.remote}` : st.backend);
/** The models to suggest: the host’s for an agent that runs on one, else this computer’s. */
const suggested = (st) => byRan(st.remote ? (st.modelLists?.[sourceOf(st)]?.models ?? []) : modelsFor(st.backend), ranOf(st));
/** How each model’s last turn ended there, as the list’s answer gave it; nothing until it has answered. */
const ranOf = (st) => st.modelLists?.[sourceOf(st)]?.ran ?? null;

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
      st.modelLists[source] = { models, fresh: r?.fresh === true, why: r?.why ?? null, ran: r?.ran ?? null };
      const caps = client.config.backends?.[backend];
      if (!hostId && caps && models.length) caps.models = models;
      pickModel(st);
      paint();
    },
    () => {
      st.modelLists[source] = { models: hostId ? [] : modelsFor(backend), fresh: false, why: null };
      paint();
    },
  );
}

/**
 * The model Postbox picks while the person hasn’t (st.modelDefaulted): one that answered there last, since the
 * harness’s first may be one this sign-in can’t run (#1977); else its default among the list. Run on each paint, so
 * moving the agent to another host or backend and back picks for where it is now. Effort follows a model that changed.
 * @param {any} st
 */
function pickModel(st) {
  const list = st.modelLists?.[sourceOf(st)];
  if (!st.modelDefaulted || !list) return;
  const was = st.model;
  const ranHere = ranDefault(list.ran);
  if (ranHere && list.ran[st.model]?.ended !== 'answered') st.model = ranHere;
  else if (!ranHere && list.models.length && !list.models.includes(st.model)) st.model = modelDefault(st.backend, client.config, list.models);
  if (st.model !== was) st.effort = effortNamedBy(st.backend, st.model) ?? st.effort;
}

/**
 * What the field can say about where its suggestions came from, for the current backend and host: each message, and
 * the one it says now, or null when the harness listed them just now.
 * @returns {{ shown: string | null, all: string[], host?: string }}
 */
function listHelp(st) {
  const name = BACKENDS.find(([id]) => id === st.backend)?.[1] ?? st.backend;
  const list = st.modelLists?.[sourceOf(st)];
  /** One message for each answer: listed none, or listed some before. @param {string} why */
  const either = (why, some, none) => ({ some: `${why}${some}`, none: `${why}${none}` });
  /** @type {Record<string, { some: string, none: string }>} */
  let answers;
  let asking;
  const host = st.remote ? (client.state.hosts?.[st.remote]?.name ?? 'the host') : undefined;
  if (!st.remote) {
    asking = `Asking ${name} for its models…`;
    answers = {
      'not-listed': {
        some: `${name} didn’t list its models just now, so these are the ones it listed last. Any model you type goes to it as --model.`,
        none: `${name} didn’t list its models, so type the one you want: it goes to ${name} as --model.`,
      },
    };
  } else {
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
  if (list === undefined || list?.fresh) return { shown: null, all, host };
  if (list === null) return { shown: asking, all, host };
  const answer = (Object.hasOwn(answers, list.why ?? '') ? answers[list.why] : null) ?? answers['not-listed'];
  return { shown: list.models.length ? answer.some : answer.none, all, host };
}

/**
 * The help under the field, in one place whose height never changes with the answer (#1327): every message it could
 * show for this backend and host sits in the same grid cell, only the one it says now showing, so the cell is as tall
 * as the tallest and the answer coming in moves nothing below it, Save included. Choosing another backend or host may
 * resize it, with the person’s own click.
 * @param {{ shown: string | null, all: string[], host?: string }} help @param {string} idp
 */
function helpSlot(help, idp) {
  const words = (/** @type {string} */ text) => withHost(text, help.host);
  return h(
    'span.help.held-help',
    help.all.map((text) =>
      text === help.shown ? h('span', { id: `${idp}-m-help`, 'data-model-help': '' }, words(text)) : h('span', { 'aria-hidden': 'true' }, words(text)),
    ),
  );
}

/**
 * A message with its host’s name kept whole (#1497): a name like gpu-build-a100-03.lab.example.net moves to the next
 * line, rather than breaking at a hyphen, unless it’s longer than a line. @param {string} text @param {string} [host]
 */
function withHost(text, host) {
  if (!host || !text.includes(host)) return text;
  return text.split(host).flatMap((part, i) => (i ? [h('span.host-name', host), part] : [part]));
}

/**
 * What a suggestion says beside its name: how its last turn there ended and when, for one a turn has tried; else
 * Codex’s name for its own default; else nothing.
 * @param {any} st @param {string} m @param {Record<string, { ended: string, at: number }> | null} ran
 */
function markOf(st, m, ran) {
  if (ran?.[m]) return `${ran[m].ended} ${ago(ran[m].at)}`;
  return codexDefault(st.backend, m) ? modelName(st.backend, m) : null;
}

/**
 * The field for st.model. idp prefixes element ids.
 * @param {any} st @param {() => void} paint @param {{ idp: string }} opts
 */
export function modelField(st, paint, { idp }) {
  askModels(st, paint);
  pickModel(st);
  const help = listHelp(st);
  const real = capsOf(st.backend).local || st.remote;
  const ran = ranOf(st);
  const where = st.remote ? `on ${client.state.hosts?.[st.remote]?.name ?? 'the host'}` : 'here';
  const said = (/** @type {string} */ model) => ranWords(ran?.[model], { where, when: ran?.[model] ? ago(ran[model].at) : '' }) ?? '';
  return h(
    'div.field',
    h('label.label', { for: `${idp}-m` }, 'Model'),
    h('input.input.mono', {
      id: `${idp}-m`,
      value: st.model,
      list: `${idp}-models`,
      spellcheck: 'false',
      'aria-describedby': [help.shown ? `${idp}-m-help` : null, ran ? `${idp}-m-ran` : null].filter(Boolean).join(' ') || null,
      oninput: (e) => {
        st.model = e.target.value.trim();
        st.modelDefaulted = false;
        // Written in place: a repaint would take the caret from the field they are typing in.
        const line = document.getElementById(`${idp}-m-ran`);
        if (line) line.textContent = said(st.model);
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
      // Each suggestion a turn has tried says so beside its name, so the groups are told apart by more than their place.
      suggested(st).map((m) => h('option', { value: m, label: markOf(st, m, ran) })),
    ),
    // Only once a turn there has said something, and then with its line kept whether the model in the field has a
    // record or not, so typing moves nothing below it.
    ran ? h('span.help.ran-line', { id: `${idp}-m-ran`, 'data-model-ran': '' }, said(st.model)) : null,
    real ? helpSlot(help, idp) : null,
    // Codex picks its own model for `auto`: it isn’t one of Claude’s.
    st.backend === 'codex' ? h('span.help', 'auto is Codex’s default: the model your Codex configuration picks.') : null,
  );
}
