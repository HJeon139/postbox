// The tiny schema language the block catalog (catalog.mjs) is written in. Moved out of catalog.mjs.
// Pure and dependency-free, like the catalog.

/** @typedef {(v: any, path: string, errs: string[]) => unknown} Rule */

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

// ── A tiny schema language ──────────────────────────────────────────────────────────────
// Each rule is (value, path, errors) => void and pushes plain-English messages.

export const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/** @type {(opts?: { max?: number, min?: number, pattern?: RegExp, label?: string }) => Rule} */
export const str =
  ({ max = 2000, min = 0, pattern, label } = {}) =>
  (v, path, errs) => {
    if (typeof v !== 'string') return errs.push(`${path} must be text, not ${typeName(v)}.`);
    if (v.length < min) errs.push(min === 1 ? `${path} can’t be empty.` : `${path} needs at least ${min} characters.`);
    if (v.length > max) errs.push(`${path} is longer than ${max.toLocaleString('en-US')} characters.`);
    if (pattern && !pattern.test(v)) errs.push(`${path} isn’t a valid ${label ?? 'value'}.`);
  };
export const id = () => str({ min: 1, max: 64, pattern: ID, label: 'id (letters, digits, - _ . :)' });
export const int =
  ({ min = -Infinity, max = Infinity } = {}) =>
  (v, path, errs) => {
    if (!Number.isInteger(v)) return errs.push(`${path} must be a whole number.`);
    if (v < min || v > max) errs.push(`${path} must be between ${min} and ${max}.`);
  };
export const num = () => (v, path, errs) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path} must be a number.`);
};
export const bool = () => (v, path, errs) => {
  if (typeof v !== 'boolean') errs.push(`${path} must be true or false.`);
};
export const oneOf =
  (...allowed) =>
  (v, path, errs) => {
    if (!allowed.includes(v)) errs.push(`${path} must be one of ${allowed.map((a) => `“${a}”`).join(', ')}.`);
  };
export const scalar = () => (v, path, errs) => {
  if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
    errs.push(`${path} must be text, a number, true/false or null.`);
  }
};
/** @type {(of: Rule, opts?: { min?: number, max?: number, unique?: string }) => Rule} */
export const list =
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
export const obj =
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
