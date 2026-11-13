// A choice’s or a select’s options, and a card’s actions: the catalog’s rules for an option (shared/catalog.mjs).
// Moved out of catalog.mjs.

import { LIMITS } from './limits.mjs';
import { id, list, obj, str } from './schema.mjs';

// An option may say more under its label (#838): agents gave options a description, and the whole block was refused.
export const option = () => obj({ id: id(), label: str({ min: 1, max: 120 }), description: str({ min: 1, max: LIMITS.optionDescription }) }, ['id', 'label']);
/** Whether every option is a string: a non-empty list of nothing but strings. @param {unknown} v */
const allStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((o) => typeof o === 'string');
/**
 * A choice’s or a select’s options. Options that are all strings, an easy guess, get one error that shows an option’s
 * shape, from the first, rather than one for each (#455). @param {number} max @returns {import('./schema.mjs').Rule}
 */
export const options = (max) => (v, path, errs) => {
  if (!allStrings(v)) return list(option(), { min: 1, max, unique: 'id' })(v, path, errs);
  // The example has to be a valid option itself: from the first label that gives an id, else the first that isn’t
  // empty, with “one” as its id (#951).
  const labels = v.map((o) => o.slice(0, 40)).filter((o) => o.trim() !== '');
  const named = labels.find((o) => idOf(o) !== '');
  const label = named ?? labels[0] ?? 'One';
  const id = named ? idOf(named) : 'one';
  // lint-allow quotes: the JSON an agent writes, whose quotes are JSON’s.
  errs.push(`${path} must be objects like { "id": ${JSON.stringify(id)}, "label": ${JSON.stringify(label)} }, not strings.`);
};
/**
 * An option id from a label, or '' when it has no letter or digit: lower case, other characters as `-`, starting at its
 * first letter or digit, since an id must (schema.mjs’s ID), and with no `-` at the end. @param {string} label
 */
function idOf(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
}
