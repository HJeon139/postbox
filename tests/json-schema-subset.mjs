// The part of JSON Schema that shared/schema.mjs’s rules describe (#1319): a checker, as an MCP client would read
// show_block’s inputSchema, and a sampler that makes values the schema accepts. Tests only; Postbox has no
// JSON Schema dependency. A keyword outside this part fails the test, so the generator can’t drift past it.

const KNOWN = new Set([
  'type',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'description',
]);

/** A value’s JSON Schema type. @param {unknown} v */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}
const isType = (v, t) => typeOf(v) === t || (t === 'number' && typeof v === 'number' && Number.isFinite(v));

/** Why value isn’t accepted by schema, as a list of paths; empty when it is. */
export function check(schema, v, path = '$') {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`${path}: keyword “${k}” is outside the subset`);
  const errs = [];
  const types = schema.type === undefined ? null : [schema.type].flat();
  if (types && !types.some((t) => isType(v, t))) return [`${path}: not ${types.join('|')}`];
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: not in enum`);
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) errs.push(`${path}: too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errs.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: pattern`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${path}: above maximum`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${path}: too few`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${path}: too many`);
    if (schema.items) for (const [i, x] of v.entries()) errs.push(...check(schema.items, x, `${path}[${i}]`));
  }
  if (typeOf(v) === 'object') {
    for (const k of schema.required ?? []) if (v[k] === undefined) errs.push(`${path}.${k}: required`);
    for (const [k, x] of Object.entries(v)) {
      const p = schema.properties?.[k];
      if (p) errs.push(...check(p, x, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unknown`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...check(schema.additionalProperties, x, `${path}.${k}`));
    }
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => check(s, v, path).length === 0).length;
    if (n !== 1) errs.push(`${path}: matches ${n} of oneOf`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => check(s, v, path).length === 0)) errs.push(`${path}: matches none of anyOf`);
  return errs;
}

/** A seeded random number generator, so a failure repeats. @param {number} seed */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A value schema accepts, at random. A string with a pattern is the first of a few candidates that matches it, so a
 * pattern none of them match fails the test; every string is numbered, so ids stay unique within one sample.
 * @param {any} schema @param {() => number} r
 */
export function sample(schema, r, state = { n: 0 }) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  if (schema.oneOf || schema.anyOf) return sample(pick(schema.oneOf ?? schema.anyOf), r, state);
  if (schema.enum) return pick(schema.enum);
  const type = Array.isArray(schema.type) ? pick(schema.type) : schema.type;
  state.n++;
  switch (type) {
    case 'string': {
      if (schema.pattern) {
        const made = [`a${state.n}`, `@ab${state.n}`].find((c) => new RegExp(schema.pattern).test(c));
        if (!made) throw new Error(`No sample for the pattern ${schema.pattern}`);
        return made;
      }
      const len = between(schema.minLength ?? 0, Math.min(schema.maxLength ?? 12, 12));
      return `s${state.n}`.padEnd(len, 'x').slice(0, len);
    }
    case 'integer':
      return between(Math.max(schema.minimum ?? -50, -50), Math.min(schema.maximum ?? 50, 50));
    case 'number':
      return Math.round(r() * 1000) / 10;
    case 'boolean':
      return r() < 0.5;
    case 'null':
      return null;
    case 'array': {
      const n = between(schema.minItems ?? 0, Math.min(schema.maxItems ?? 3, 3));
      return Array.from({ length: n }, () => sample(schema.items ?? { type: 'string' }, r, state));
    }
    case 'object': {
      const out = {};
      for (const [k, p] of Object.entries(schema.properties ?? {})) if ((schema.required ?? []).includes(k) || r() < 0.5) out[k] = sample(p, r, state);
      if (typeof schema.additionalProperties === 'object' && r() < 0.5) out[`k${state.n}`] = sample(schema.additionalProperties, r, state);
      return out;
    }
    default:
      throw new Error(`No sample for ${JSON.stringify(schema).slice(0, 80)}`);
  }
}
