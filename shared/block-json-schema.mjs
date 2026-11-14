// Each block type’s JSON Schema, made from the catalog’s own rules (#1319): show_block and update_block advertise
// them, so the model reads the exact shape the catalog checks, with no copy to fall out of step. The few checks
// across fields that a JSON Schema can’t say (a select needs options, a cell’s column exists) stay validateBlock’s.
// Pure and node-free, as shared/mcp-tools.mjs, which a host serves, needs (#120).
//
// Keyed by type with anyOf, not oneOf: each type’s schema fixes type to one value, so the two take the same blocks,
// and anyOf is the one every backend’s model API takes (checked for Claude Code and Codex in #1319).

import { CATALOG, COMMON, COMMON_REQUIRED, SCHEMAS } from './catalog.mjs';
import { objectJson } from './schema.mjs';

const TYPES = Object.keys(CATALOG);

/** One type’s JSON Schema: its fields with the common ones, type fixed to it, and its newest version. @param {string} type */
export function typeSchema(type) {
  const { fields, required } = SCHEMAS[/** @type {keyof typeof SCHEMAS} */ (type)];
  const json = objectJson({ ...COMMON, ...fields }, [...COMMON_REQUIRED, ...required]);
  json.properties.type = { type: 'string', enum: [type] };
  json.properties.version = { type: 'integer', minimum: 1, maximum: CATALOG[/** @type {keyof typeof CATALOG} */ (type)] };
  return json;
}

const DESCRIPTION =
  'A block from the catalog, by its type: { id, type, version, title?, fallback, …its fields }. designs/agent-apps.md, “The block catalog”, says what each type shows.';

/**
 * A review carries its images as files, which Postbox reads from the agent’s folder and takes off the block before
 * the catalog checks it (server/review-files.mjs, #780). @param {Record<string, any>} json @param {Record<string, any>} files
 */
const withFiles = (json, files) => (json.properties.type.enum[0] === 'review' ? { ...json, properties: { ...json.properties, files } } : json);

/**
 * show_block’s block. An outcome comes later, by update_block, once the person has answered (#94).
 * @param {Record<string, any>} files  the JSON Schema of a review’s files
 */
export function shownBlock(files) {
  const types = TYPES.map((t) => {
    const { outcome: _, ...properties } = typeSchema(t).properties;
    return withFiles({ ...typeSchema(t), properties }, files);
  });
  return { type: 'object', description: DESCRIPTION, anyOf: types };
}

/**
 * update_block’s block: a whole block, or { id, outcome } or { id, withdraw }, which server/blocks.mjs reads by
 * shared/block-updates.mjs’s updateKind. @param {Record<string, any>} files  the JSON Schema of a review’s files
 */
export function updatedBlock(files) {
  const { id, outcome } = typeSchema('choice').properties;
  return {
    type: 'object',
    description: `${DESCRIPTION} Or { id, outcome } to report a result under the person’s answer, or { id, withdraw } to close it.`,
    anyOf: [
      ...TYPES.map((t) => withFiles(typeSchema(t), files)),
      { type: 'object', properties: { id, outcome }, required: ['id', 'outcome'] },
      { type: 'object', properties: { id, withdraw: outcome }, required: ['id', 'withdraw'] },
    ],
  };
}
