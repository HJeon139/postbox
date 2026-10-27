// The block catalog: one schema per component, and the validator every block passes before it is shown.
// Pure and dependency-free, so the server, the browser and the tests share it.
//
// A block is JSON naming one component. Every block has id, type, version, an optional title and a
// plain-text fallback. A block that fails validation is never rendered: the app shows its fallback
// and a collapsed "Show the raw block" instead.

import { LIMITS } from './limits.mjs';
import { ANCHOR, anchorError } from './review-comments.mjs';
import { bool, id, int, list, num, obj, oneOf, scalar, str, typeName } from './schema.mjs';
import { isSafeUrl, LOCAL_HTTP } from './urls.mjs';

/** The newest version of each component this app can render. */
export const CATALOG = Object.freeze({
  choice: 1,
  form: 1,
  table: 1,
  progress: 1,
  card: 1,
  confirm: 1,
  image: 1,
  code: 1,
  review: 1,
  app: 1,
});

/** Components that ask you something; an open one makes its agent "need you". */
export const ASKING = new Set(['choice', 'form', 'confirm', 'review']);

/**
 * Whether an update brings its block to the newest point in the conversation, with a stub where it was (#49, #92).
 * One rule for apps and blocks: an update the person has to act on, beside the agent’s note about it. That’s every
 * new version of an app, and an update that leaves a choice, form, confirm or review waiting on the person. An
 * outcome reports on an answer and asks nothing, and progress, cards, tables, code and images don’t wait on the
 * person, so they keep their place: a progress block moving on every step would be noise.
 * @param {{ type: string, outcome?: unknown }} block  the block as updated
 */
export const followsConversation = (block) => block.type === 'app' || (ASKING.has(block.type) && typeof block.outcome !== 'string');

/**
 * A block as the agent sent it, once it has passed validateBlock.
 * @typedef {{ id: string, type: string, version: number, title?: string, fallback: string, [field: string]: any }} Block
 */

const LANG = /^[A-Za-z0-9_+#.-]{1,32}$/;

const option = () => obj({ id: id(), label: str({ min: 1, max: 120 }) }, ['id', 'label']);
/**
 * A choice’s or a select’s options. Options written as plain strings, an easy guess, get one error that shows the
 * shape, not one per option and one per pair of “undefined” ids (#455). @param {number} max
 */
const options = (max) => /** @type {import('./schema.mjs').Rule} */ (v, path, errs) => {
  const text = Array.isArray(v) ? v.find((o) => typeof o === 'string') : undefined;
  if (text === undefined) return list(option(), { min: 1, max, unique: 'id' })(v, path, errs);
  const id =
    text
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'one';
  // lint-allow quotes: the JSON an agent writes, whose quotes are JSON’s.
  errs.push(`${path} must be { id, label } objects, not text: write each as { "id": "${id}", "label": ${JSON.stringify(text)} }.`);
};
// A result reported on an answered block (#94), or an approved review (#106), shown under the answer. Markdown.
const outcome = () => str({ min: 1, max: LIMITS.outcome });

// ── Component schemas ───────────────────────────────────────────────────────────────────

const COMMON = { id: id(), type: str(), version: int({ min: 1, max: 999 }), title: str({ max: 200 }), fallback: str({ min: 1, max: LIMITS.fallback }) };
const COMMON_REQUIRED = ['id', 'type', 'version', 'fallback'];

const SCHEMAS = {
  choice: {
    fields: {
      prompt: str({ max: LIMITS.prompt }),
      options: options(LIMITS.choiceOptions),
      multiple: bool(),
      max: int({ min: 1, max: LIMITS.choiceOptions }),
      other: obj({ label: str({ min: 1, max: 80 }), placeholder: str({ max: 120 }) }, ['label']),
      display: oneOf('chips', 'buttons'),
      submitLabel: str({ min: 1, max: 40 }),
      outcome: outcome(),
    },
    required: ['options'],
  },
  form: {
    fields: {
      prompt: str({ max: LIMITS.prompt }),
      fields: list(
        obj(
          {
            id: id(),
            label: str({ min: 1, max: 120 }),
            kind: oneOf('text', 'longtext', 'number', 'select', 'toggle', 'date'),
            required: bool(),
            placeholder: str({ max: 120 }),
            help: str({ max: 300 }),
            min: num(),
            max: num(),
            step: num(),
            maxLength: int({ min: 1, max: 20000 }),
            options: options(LIMITS.selectOptions),
            default: scalar(),
          },
          ['id', 'label', 'kind'],
        ),
        { min: 1, max: LIMITS.formFields, unique: 'id' },
      ),
      submitLabel: str({ min: 1, max: 40 }),
      outcome: outcome(),
    },
    required: ['fields'],
    check(b, errs) {
      for (const [i, f] of (b.fields ?? []).entries()) {
        if (f?.kind === 'select' && !f.options) errs.push(`fields[${i}] is a select, so it needs options.`);
        if (f?.kind !== 'select' && f?.options) errs.push(`fields[${i}].options only applies to a select.`);
      }
    },
  },
  table: {
    fields: {
      columns: list(obj({ id: id(), label: str({ min: 1, max: 80 }), kind: oneOf('text', 'number'), sortable: bool() }, ['id', 'label']), {
        min: 1,
        max: LIMITS.tableColumns,
        unique: 'id',
      }),
      rows: list(
        obj(
          {
            id: id(),
            cells: (v, p, e) => {
              if (v === null || typeof v !== 'object' || Array.isArray(v)) return e.push(`${p} must be an object.`);
              for (const [k, c] of Object.entries(v)) scalar()(c, `${p}.${k}`, e);
            },
          },
          ['id', 'cells'],
        ),
        { max: LIMITS.tableRows, unique: 'id' },
      ),
      rowAction: obj({ id: id(), label: str({ min: 1, max: 40 }) }, ['id', 'label']),
    },
    required: ['columns', 'rows'],
    check(b, errs) {
      const cols = new Set((b.columns ?? []).map((c) => c?.id));
      for (const [i, r] of (b.rows ?? []).entries()) {
        for (const k of Object.keys(r?.cells ?? {}))
          if (!cols.has(k)) {
            errs.push(`rows[${i}] has a cell for an unknown column “${k}”.`);
            break;
          }
      }
    },
  },
  progress: {
    fields: {
      steps: list(
        obj(
          {
            id: id(),
            label: str({ min: 1, max: 200 }),
            // stalled: Postbox marks a step left running when its agent’s turn ended.
            state: oneOf('pending', 'running', 'done', 'failed', 'stalled'),
            detail: str({ max: 300 }),
            duration: str({ max: 20 }),
            // How far along a running step is: a count (“2 of 4 papers”), or a percent when there’s nothing to count.
            progress: obj({ done: int({ min: 0, max: 1e9 }), total: int({ min: 1, max: 1e9 }), unit: str({ min: 1, max: 24 }) }, ['done', 'total']),
            percent: int({ min: 0, max: 100 }),
            eta: str({ max: 20 }),
          },
          ['id', 'label', 'state'],
        ),
        { min: 1, max: LIMITS.progressSteps, unique: 'id' },
      ),
    },
    required: ['steps'],
    check(b, errs) {
      for (const [i, s] of (b.steps ?? []).entries())
        if (s?.progress && s.progress.done > s.progress.total) errs.push(`steps[${i}].progress.done can’t be more than its total.`);
    },
  },
  card: {
    fields: {
      body: str({ max: LIMITS.cardBody }),
      facts: list(obj({ label: str({ min: 1, max: 80 }), value: scalar() }, ['label', 'value']), { max: LIMITS.cardFacts }),
      actions: list(option(), { max: LIMITS.cardActions, unique: 'id' }),
    },
    required: [],
  },
  confirm: {
    fields: {
      statement: str({ min: 1, max: LIMITS.prompt }),
      confirmLabel: str({ min: 1, max: 48 }),
      cancelLabel: str({ min: 1, max: 48 }),
      outcome: outcome(),
    },
    required: ['statement', 'confirmLabel'],
  },
  image: {
    fields: {
      src: str({ min: 1, max: 2048 }),
      alt: str({ min: 1, max: 400 }),
      caption: str({ max: 300 }),
      width: int({ min: 1, max: 8000 }),
      height: int({ min: 1, max: 8000 }),
    },
    required: ['src', 'alt'],
    check(b, errs, opts) {
      if (typeof b.src !== 'string') return;
      // https from an allowed origin; plain http only for Postbox itself on this machine.
      const local = LOCAL_HTTP.test(b.src);
      if (!isSafeUrl(b.src, { schemes: local ? ['http:'] : ['https:'], origins: opts.imageOrigins })) {
        errs.push(`src must be an https address from an allowed origin (${(opts.imageOrigins ?? []).join(', ') || 'none configured'}).`);
      }
    },
  },
  code: {
    fields: { code: str({ max: LIMITS.longText }), language: str({ pattern: LANG, label: 'language name' }), filename: str({ max: 200 }) },
    required: ['code'],
  },
  review: {
    fields: {
      format: oneOf('markdown', 'code', 'app'),
      content: str({ max: LIMITS.longText }),
      previous: str({ max: LIMITS.longText }),
      appId: id(),
      language: str({ pattern: LANG, label: 'language name' }),
      filename: str({ max: 200 }),
      revision: int({ min: 1, max: 9999 }),
      threads: list(
        obj(
          {
            id: id(),
            // A line, or a selection with its quote (#179), as a comment is (review-comments.mjs).
            ...ANCHOR,
            anchor: str({ min: 1, max: 80 }),
            status: oneOf('open', 'resolved'),
            comments: list(obj({ author: str({ min: 1, max: 64 }), text: str({ min: 1, max: 4000 }) }, ['author', 'text']), { min: 1, max: 50 }),
          },
          ['id', 'status', 'comments'],
        ),
        { max: 200, unique: 'id' },
      ),
      outcome: outcome(),
    },
    required: ['format'],
    check(b, errs) {
      if (b.format === 'app' && !b.appId) errs.push('An app review needs appId.');
      if (b.format && b.format !== 'app' && typeof b.content !== 'string') errs.push(`A ${b.format} review needs content.`);
      for (const [i, t] of (b.threads ?? []).entries()) {
        const why = anchorError(t);
        if (why) errs.push(`threads[${i}]: ${why}`);
      }
    },
  },
  app: {
    fields: {
      code: str({ min: 1, max: LIMITS.appCode }),
      permissions: list(str({ min: 1, max: 64, pattern: /^[a-z][a-z0-9_.]*$/, label: 'tool name' }), { max: 12 }),
    },
    required: ['code'],
  },
};

/**
 * Validates one block against the catalog.
 * @param {any} raw  the block as the agent sent it
 * @param {{ imageOrigins?: string[] }} [opts]
 * @returns {{ ok: true, block: Block } | { ok: false, errors: string[], fallback: string, reason: 'unknown-type'|'newer-version'|'invalid' }}
 */
export function validateBlock(raw, opts = {}) {
  const errors = [];
  const fallback =
    typeof raw?.fallback === 'string' && raw.fallback.trim() ? raw.fallback : 'This block couldn’t be shown, and it didn’t include a text version.';
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [`A block must be an object, not ${typeName(raw)}.`], fallback, reason: 'invalid' };
  }
  if (typeof raw.type !== 'string' || !Object.hasOwn(CATALOG, raw.type)) {
    return {
      ok: false,
      errors: [`Unknown type “${String(raw.type)}”. This app’s catalog has ${Object.keys(CATALOG).join(', ')}.`],
      fallback,
      reason: 'unknown-type',
    };
  }
  if (Number.isInteger(raw.version) && raw.version > CATALOG[raw.type]) {
    return {
      ok: false,
      errors: [`This ${raw.type} block is version ${raw.version}, and this app reads up to version ${CATALOG[raw.type]}. Update Postbox to see it in full.`],
      fallback,
      reason: 'newer-version',
    };
  }
  const schema = SCHEMAS[raw.type];
  obj({ ...COMMON, ...schema.fields }, [...COMMON_REQUIRED, ...schema.required])(raw, 'block', errors);
  if (!errors.length) schema.check?.(raw, errors, opts);
  // Paths read better without the leading "block." for people.
  const clean = errors.map((e) => e.replace(/^block\./, '').replace(/^block /, 'The block '));
  return clean.length ? { ok: false, errors: clean, fallback, reason: 'invalid' } : { ok: true, block: raw };
}
