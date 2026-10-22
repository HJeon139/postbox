// The block catalog: one schema per component, and the validator every block passes before it is shown.
// Pure and dependency-free, so the server, the browser and the tests share it.
//
// A block is JSON naming one component. Every block has id, type, version, an optional title and a
// plain-text fallback. A block that fails validation is never rendered: the app shows its fallback
// and a collapsed "Show the raw block" instead.

import { isSafeUrl } from './urls.mjs';

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
 * A block as the agent sent it, once it has passed validateBlock.
 * @typedef {{ id: string, type: string, version: number, title?: string, fallback: string, [field: string]: any }} Block
 */
/** @typedef {(v: any, path: string, errs: string[]) => unknown} Rule */

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const LANG = /^[A-Za-z0-9_+#.-]{1,32}$/;

// ── A tiny schema language ──────────────────────────────────────────────────────────────
// Each rule is (value, path, errors) => void and pushes plain-English messages.

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/** @type {(opts?: { max?: number, min?: number, pattern?: RegExp, label?: string }) => Rule} */
const str =
  ({ max = 2000, min = 0, pattern, label } = {}) =>
  (v, path, errs) => {
    if (typeof v !== 'string') return errs.push(`${path} must be text, not ${typeName(v)}.`);
    if (v.length < min) errs.push(min === 1 ? `${path} can’t be empty.` : `${path} needs at least ${min} characters.`);
    if (v.length > max) errs.push(`${path} is longer than ${max.toLocaleString('en-US')} characters.`);
    if (pattern && !pattern.test(v)) errs.push(`${path} isn’t a valid ${label ?? 'value'}.`);
  };
const id = () => str({ min: 1, max: 64, pattern: ID, label: 'id (letters, digits, - _ . :)' });
const int =
  ({ min = -Infinity, max = Infinity } = {}) =>
  (v, path, errs) => {
    if (!Number.isInteger(v)) return errs.push(`${path} must be a whole number.`);
    if (v < min || v > max) errs.push(`${path} must be between ${min} and ${max}.`);
  };
const num = () => (v, path, errs) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path} must be a number.`);
};
const bool = () => (v, path, errs) => {
  if (typeof v !== 'boolean') errs.push(`${path} must be true or false.`);
};
const oneOf =
  (...allowed) =>
  (v, path, errs) => {
    if (!allowed.includes(v)) errs.push(`${path} must be one of ${allowed.map((a) => `“${a}”`).join(', ')}.`);
  };
const scalar = () => (v, path, errs) => {
  if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
    errs.push(`${path} must be text, a number, true/false or null.`);
  }
};
/** @type {(of: Rule, opts?: { min?: number, max?: number, unique?: string }) => Rule} */
const list =
  (of, { min = 0, max = 100, unique } = {}) =>
  (v, path, errs) => {
    if (!Array.isArray(v)) return errs.push(`${path} must be a list, not ${typeName(v)}.`);
    if (v.length < min) errs.push(min === 1 ? `${path} needs at least one item.` : `${path} needs at least ${min} items.`);
    if (v.length > max) errs.push(`${path} has more than ${max.toLocaleString('en-US')} items.`);
    v.slice(0, max).forEach((item, i) => {
      of(item, `${path}[${i}]`, errs);
    });
    if (unique) {
      const seen = new Set();
      for (const item of v) {
        const k = item?.[unique];
        if (seen.has(k)) errs.push(`${path} has two items with the ${unique} “${k}”.`);
        seen.add(k);
      }
    }
  };
// Objects are strict: an unknown field is an error, so a misspelled field never fails silently.
const obj =
  (fields, required = []) =>
  (v, path, errs) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return errs.push(`${path} must be an object, not ${typeName(v)}.`);
    for (const k of required) if (v[k] === undefined) errs.push(`${path}.${k} is required.`);
    for (const [k, val] of Object.entries(v)) {
      if (!(k in fields)) {
        errs.push(`${path} has an unknown field “${k}”.`);
        continue;
      }
      if (val !== undefined) fields[k](val, `${path}.${k}`, errs);
    }
  };
const option = () => obj({ id: id(), label: str({ min: 1, max: 120 }) }, ['id', 'label']);

// ── Component schemas ───────────────────────────────────────────────────────────────────

const COMMON = { id: id(), type: str(), version: int({ min: 1, max: 999 }), title: str({ max: 200 }), fallback: str({ min: 1, max: 4000 }) };
const COMMON_REQUIRED = ['id', 'type', 'version', 'fallback'];

const SCHEMAS = {
  choice: {
    fields: {
      prompt: str({ max: 2000 }),
      options: list(option(), { min: 1, max: 24, unique: 'id' }),
      multiple: bool(),
      max: int({ min: 1, max: 24 }),
      other: obj({ label: str({ min: 1, max: 80 }), placeholder: str({ max: 120 }) }, ['label']),
      display: oneOf('chips', 'buttons'),
      submitLabel: str({ min: 1, max: 40 }),
    },
    required: ['options'],
  },
  form: {
    fields: {
      prompt: str({ max: 2000 }),
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
            options: list(option(), { min: 1, max: 50, unique: 'id' }),
            default: scalar(),
          },
          ['id', 'label', 'kind'],
        ),
        { min: 1, max: 24, unique: 'id' },
      ),
      submitLabel: str({ min: 1, max: 40 }),
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
        max: 16,
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
        { max: 5000, unique: 'id' },
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
        { min: 1, max: 60, unique: 'id' },
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
      body: str({ max: 4000 }),
      facts: list(obj({ label: str({ min: 1, max: 80 }), value: scalar() }, ['label', 'value']), { max: 16 }),
      actions: list(option(), { max: 3, unique: 'id' }),
    },
    required: [],
  },
  confirm: {
    fields: { statement: str({ min: 1, max: 2000 }), confirmLabel: str({ min: 1, max: 48 }), cancelLabel: str({ min: 1, max: 48 }) },
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
      const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(b.src);
      if (!isSafeUrl(b.src, { schemes: local ? ['http:'] : ['https:'], origins: opts.imageOrigins })) {
        errs.push(`src must be an https address from an allowed origin (${(opts.imageOrigins ?? []).join(', ') || 'none configured'}).`);
      }
    },
  },
  code: {
    fields: { code: str({ max: 200000 }), language: str({ pattern: LANG, label: 'language name' }), filename: str({ max: 200 }) },
    required: ['code'],
  },
  review: {
    fields: {
      format: oneOf('markdown', 'code', 'app'),
      content: str({ max: 200000 }),
      previous: str({ max: 200000 }),
      appId: id(),
      language: str({ pattern: LANG, label: 'language name' }),
      filename: str({ max: 200 }),
      revision: int({ min: 1, max: 9999 }),
      threads: list(
        obj(
          {
            id: id(),
            line: int({ min: 1, max: 200000 }),
            anchor: str({ min: 1, max: 80 }),
            status: oneOf('open', 'resolved'),
            comments: list(obj({ author: str({ min: 1, max: 64 }), text: str({ min: 1, max: 4000 }) }, ['author', 'text']), { min: 1, max: 50 }),
          },
          ['id', 'status', 'comments'],
        ),
        { max: 200, unique: 'id' },
      ),
    },
    required: ['format'],
    check(b, errs) {
      if (b.format === 'app' && !b.appId) errs.push('An app review needs appId.');
      if (b.format && b.format !== 'app' && typeof b.content !== 'string') errs.push(`A ${b.format} review needs content.`);
    },
  },
  app: {
    fields: { code: str({ min: 1, max: 600000 }), permissions: list(str({ min: 1, max: 64, pattern: /^[a-z][a-z0-9_.]*$/, label: 'tool name' }), { max: 12 }) },
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
