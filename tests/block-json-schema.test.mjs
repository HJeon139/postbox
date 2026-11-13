// #1319: show_block and update_block advertise each block type’s JSON Schema, made from the catalog’s own rules
// (shared/block-json-schema.mjs), so the model sees the exact shape. The schema and validateBlock are one source:
// what the schema accepts, the catalog accepts, except the few checks across fields that JSON Schema can’t say.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_EXAMPLES } from '../shared/block-examples.mjs';
import { typeSchema } from '../shared/block-json-schema.mjs';
import { CATALOG, validateBlock } from '../shared/catalog.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { check, rng, sample } from './json-schema-subset.mjs';

const TYPES = Object.keys(CATALOG);
const blockOf = (name) => TOOL_DEFS.find((t) => t.name === name).inputSchema.properties.block;

// The catalog’s checks across fields, or across items, which a JSON Schema can’t say. A sample the schema accepts
// may fail only these.
const ACROSS = [
  /is a select, so it needs options\./,
  /options only applies to a select\./,
  /has a cell for an unknown column/,
  /progress\.done can’t be more than its total\./,
  /^src must be an https address/,
  /^An app review needs appId\./,
  /review needs content\./,
  /^threads\[\d+\]: a (comment on a selection|selection’s end)/,
  /has two items with the /,
];

test('#1319 show_block offers one schema per catalog type, keyed by type, and update_block takes an outcome or a withdraw too', () => {
  const shown = blockOf('show_block');
  assert.equal(shown.type, 'object', 'a client that drops oneOf still sees an object');
  assert.deepEqual(
    shown.anyOf.map((s) => s.properties.type.enum),
    TYPES.map((t) => [t]),
  );
  for (const s of shown.anyOf) assert.equal(s.properties.outcome, undefined, `${s.properties.type.enum[0]}: an outcome comes later, by update_block`);
  const updated = blockOf('update_block');
  assert.deepEqual(check(updated, { id: 'pick', outcome: 'Filed as #5.' }), []);
  assert.deepEqual(check(updated, { id: 'pick', withdraw: 'Stale.' }), []);
  assert.deepEqual(check(updated, { ...BLOCK_EXAMPLES.choice, outcome: 'Filed as #5.' }), []);
  assert.notDeepEqual(check(updated, { id: 'pick' }), []);
  assert.match(shown.description, /designs\/agent-apps\.md/);
  assert.doesNotMatch(shown.description, /README/);
});

test('#1319 every rule in the catalog says its JSON Schema: none is left as “anything”', () => {
  const empty = [];
  const walk = (s, path) => {
    if (Object.keys(s).length === 0) empty.push(path);
    for (const [k, p] of Object.entries(s.properties ?? {})) walk(p, `${path}.${k}`);
    if (s.items) walk(s.items, `${path}[]`);
    if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${path}.*`);
  };
  for (const t of TYPES) walk(typeSchema(t), t);
  assert.deepEqual(empty, []);
});

test('#1319 property: a block the schema accepts, the catalog accepts, but for checks across fields', () => {
  for (const type of TYPES) {
    const schema = typeSchema(type);
    for (let seed = 1; seed <= 300; seed++) {
      const block = sample(schema, rng(seed * 31 + type.length));
      assert.deepEqual(check(schema, block), [], `the sampler makes what the schema takes (${type}, seed ${seed})`);
      const v = validateBlock(block, { origins: 'later' });
      const stray = v.ok ? [] : v.errors.filter((e) => !ACROSS.some((re) => re.test(e)));
      assert.deepEqual(stray, [], `${type}, seed ${seed}: ${JSON.stringify(block)}`);
    }
  }
});

test('#1319 property: what the catalog refuses for its shape, the schema refuses too', () => {
  for (const type of TYPES) {
    const schema = typeSchema(type);
    const good = BLOCK_EXAMPLES[type];
    const reject = (block, why) => {
      assert.equal(validateBlock(block, { origins: 'later' }).ok, false, `the catalog refuses ${type} ${why}`);
      assert.notDeepEqual(check(schema, block), [], `the schema refuses ${type} ${why}`);
    };
    for (const k of schema.required) {
      const { [k]: _, ...without } = good;
      reject(without, `without ${k}`);
    }
    reject({ ...good, colour: 'red' }, 'with an unknown field');
    for (const [k, p] of Object.entries(schema.properties)) {
      const wrong = p.type === 'object' || p.type === 'array' ? 'text' : { not: 'this' };
      reject({ ...good, [k]: wrong }, `with ${k} of the wrong type`);
    }
    for (let seed = 1; seed <= 100; seed++) {
      // A sample with one field set past its limit: a string or a list one longer than its maximum.
      const block = sample(schema, rng(seed * 7 + type.length));
      const long = Object.entries(schema.properties).filter(([, p]) => p.maxLength !== undefined && p.maxLength < 1e6);
      if (!long.length) continue;
      const [k, p] = long[seed % long.length];
      reject({ ...block, [k]: 'x'.repeat(p.maxLength + 1) }, `with ${k} too long`);
    }
  }
});

/**
 * Each bound the schema states on a value the block holds, anywhere in it: a block with the value exactly at the bound
 * (at) and one just past it (past). Lists recurse into their first item, objects into each field they hold.
 * @param {any} schema @param {any} value @param {(v: any) => any} put  the whole block with value replaced
 * @param {string} path @returns {{ path: string, bound: string, at?: any, past?: any }[]}
 */
function bounds(schema, value, put, path) {
  const out = [];
  const probe = (bound, at, past) =>
    out.push({ path, bound, ...(at === undefined ? {} : { at: put(at) }), ...(past === undefined ? {} : { past: put(past) }) });
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined) probe('maxLength', 'a'.repeat(schema.maxLength), 'a'.repeat(schema.maxLength + 1));
    if (schema.minLength) probe('minLength', 'a'.repeat(schema.minLength), 'a'.repeat(schema.minLength - 1));
  }
  if (Number.isInteger(value)) {
    if (schema.maximum !== undefined) probe('maximum', schema.maximum, schema.maximum + 1);
    if (schema.minimum !== undefined) probe('minimum', schema.minimum, schema.minimum - 1);
  }
  if (Array.isArray(value) && value.length) {
    const fill = (n) => Array.from({ length: n }, () => structuredClone(value[0]));
    if (schema.maxItems !== undefined) probe('maxItems', fill(schema.maxItems), fill(schema.maxItems + 1));
    if (schema.minItems) probe('minItems', fill(schema.minItems), fill(schema.minItems - 1));
    if (schema.items) out.push(...bounds(schema.items, value[0], (v) => put([v, ...value.slice(1)]), `${path}[0]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties)
    for (const [k, v] of Object.entries(value))
      if (schema.properties[k]) out.push(...bounds(schema.properties[k], v, (x) => put({ ...value, [k]: x }), `${path}.${k}`));
  return out;
}

test('#1319 property: at each bound the schema states, the catalog agrees, so a schema looser than the catalog fails', () => {
  const probed = new Set();
  for (const type of TYPES) {
    const schema = typeSchema(type);
    const blocks = [BLOCK_EXAMPLES[type], ...Array.from({ length: 30 }, (_, i) => sample(schema, rng(i * 13 + type.length)))];
    for (const block of blocks)
      for (const b of bounds(schema, block, (v) => v, type)) {
        probed.add(`${b.path}.${b.bound}`);
        // At the bound, a block the schema takes (a pattern can still refuse it) is one the catalog takes.
        if (b.at !== undefined && check(schema, b.at).length === 0) {
          const v = validateBlock(b.at, { origins: 'later' });
          const stray = v.ok ? [] : v.errors.filter((e) => !ACROSS.some((re) => re.test(e)));
          assert.deepEqual(stray, [], `${b.path} at its ${b.bound}`);
        }
        if (b.past !== undefined) {
          assert.notDeepEqual(check(schema, b.past), [], `the schema refuses ${b.path} past its ${b.bound}`);
          assert.equal(validateBlock(b.past, { origins: 'later' }).ok, false, `the catalog refuses ${b.path} past its ${b.bound}`);
        }
      }
  }
  // Not a degenerate run: the common fields, nested ones, and each kind of bound were probed.
  for (const p of [
    'choice.fallback.maxLength',
    'choice.title.maxLength',
    'choice.options.maxItems',
    'choice.options[0].label.maxLength',
    'form.fields[0].id.maxLength',
    'table.rows.maxItems',
    'progress.steps[0].progress.done.minimum',
    'choice.version.maximum',
  ])
    assert.ok(probed.has(p), `${p} was probed`);
  assert.ok(probed.size > 100, `${probed.size} bounds probed`);
});

test('#1319 each type’s example, which a refusal shows, passes the catalog and the schema', () => {
  assert.deepEqual(Object.keys(BLOCK_EXAMPLES).sort(), [...TYPES].sort());
  for (const [type, block] of Object.entries(BLOCK_EXAMPLES)) {
    assert.deepEqual(validateBlock(block, { origins: 'later' }), { ok: true, block }, type);
    assert.deepEqual(check(blockOf('show_block'), block), [], type);
  }
});

test('#1319 the tool list stays a sane size with the schemas in it', () => {
  // 21.5 KB before the schemas (main at 77b94031); each turn reads the list once.
  const bytes = Buffer.byteLength(JSON.stringify(TOOL_DEFS));
  assert.ok(bytes < 48 * 1024, `${bytes} bytes`);
});
