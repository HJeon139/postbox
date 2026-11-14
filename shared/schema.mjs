// The tiny schema language the block catalog (catalog.mjs) is written in. Moved out of catalog.mjs.
// Pure and dependency-free, like the catalog.

/** @typedef {(v: any, path: string, errs: string[]) => unknown} Rule */

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

// ── A tiny schema language ──────────────────────────────────────────────────────────────
// Each rule is (value, path, errors) => void and pushes plain-English messages. Each also carries, as json, the JSON
// Schema of what it takes, which show_block and update_block advertise (#1319, shared/block-json-schema.mjs), so the
// model reads the rules the catalog checks.

/**
 * A rule with the JSON Schema of what it takes. @template {Rule} R @param {R} rule @param {Record<string, any>} json
 * @returns {R & { json: Record<string, any> }}
 */
export const described = (rule, json) => Object.assign(rule, { json });
/** A bound as JSON Schema writes it: none for an unbounded one. @param {string} key @param {number} n */
const bound = (key, n) => (Number.isFinite(n) ? { [key]: n } : {});

export const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/** @type {(opts?: { max?: number, min?: number, pattern?: RegExp, label?: string }) => Rule} */
export const str = ({ max = 2000, min = 0, pattern, label } = {}) =>
  described(
    (v, path, errs) => {
      if (typeof v !== 'string') return errs.push(`${path} must be text, not ${typeName(v)}.`);
      if (v.length < min) errs.push(min === 1 ? `${path} can’t be empty.` : `${path} needs at least ${min} characters.`);
      if (v.length > max) errs.push(`${path} is longer than ${max.toLocaleString('en-US')} characters.`);
      if (pattern && !pattern.test(v)) errs.push(`${path} isn’t a valid ${label ?? 'value'}.`);
    },
    { type: 'string', ...(min > 0 ? { minLength: min } : {}), maxLength: max, ...(pattern ? { pattern: pattern.source } : {}) },
  );
export const id = () => str({ min: 1, max: 64, pattern: ID, label: 'id (letters, digits, - _ . :)' });
export const int = ({ min = -Infinity, max = Infinity } = {}) =>
  described(
    (v, path, errs) => {
      if (!Number.isInteger(v)) return errs.push(`${path} must be a whole number.`);
      if (v < min || v > max) errs.push(`${path} must be between ${min} and ${max}.`);
    },
    { type: 'integer', ...bound('minimum', min), ...bound('maximum', max) },
  );
export const num = () =>
  described(
    (v, path, errs) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path} must be a number.`);
    },
    { type: 'number' },
  );
export const bool = () =>
  described(
    (v, path, errs) => {
      if (typeof v !== 'boolean') errs.push(`${path} must be true or false.`);
    },
    { type: 'boolean' },
  );
export const oneOf = (...allowed) =>
  described(
    (v, path, errs) => {
      if (!allowed.includes(v)) errs.push(`${path} must be one of ${allowed.map((a) => `“${a}”`).join(', ')}.`);
    },
    { type: 'string', enum: allowed },
  );
export const scalar = () =>
  described(
    (v, path, errs) => {
      if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
        errs.push(`${path} must be text, a number, true/false or null.`);
      }
    },
    { type: ['string', 'number', 'boolean', 'null'] },
  );
/** @type {(of: Rule, opts?: { min?: number, max?: number, unique?: string }) => Rule} */
export const list = (of, { min = 0, max = 100, unique } = {}) =>
  described(listRule(of, { min, max, unique }), { type: 'array', items: jsonOf(of), ...(min > 0 ? { minItems: min } : {}), maxItems: max });
/** list’s check. @param {Rule} of @param {{ min: number, max: number, unique?: string }} opts @returns {Rule} */
const listRule =
  (of, { min, max, unique }) =>
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
        // An item with no such key isn’t a duplicate: its own check says what’s wrong with it (#552).
        if (item === null || typeof item !== 'object' || item[unique] === undefined) continue;
        const k = item[unique];
        if (seen.has(k)) errs.push(`${path} has two items with the ${unique} “${k}”.`);
        seen.add(k);
      }
    }
  };
/** The JSON Schema a rule carries; {} for one that doesn’t say, which tests/block-json-schema.test.mjs refuses. */
export const jsonOf = (/** @type {any} */ rule) => rule.json ?? {};
/** The JSON Schema of an object’s fields. @param {Record<string, Rule>} fields */
export const objectJson = (fields, required = []) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(fields).map(([k, r]) => [k, jsonOf(r)])),
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
// Objects are strict: an unknown field is an error, so a misspelled field never fails silently.
export const obj = (fields, required = []) => described(objRule(fields, required), objectJson(fields, required));
/** obj’s check. @param {Record<string, Rule>} fields @param {string[]} required @returns {Rule} */
const objRule = (fields, required) => (v, path, errs) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return errs.push(`${path} must be an object, not ${typeName(v)}.`);
  for (const k of required) if (v[k] === undefined) errs.push(`${path}.${k} is required.`);
  for (const [k, val] of Object.entries(v)) {
    // Own fields only: “constructor” or “__proto__” is a name every object inherits, not a field (#39).
    if (!Object.hasOwn(fields, k)) {
      errs.push(`${path} has an unknown field “${k}”.`);
      continue;
    }
    if (val !== undefined) fields[k](val, `${path}.${k}`, errs);
  }
};
