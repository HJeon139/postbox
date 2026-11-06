import * as users from '../admin/users.mjs';
import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as reviews from './reviews.mjs';
import * as search from './search.mjs';

/** The shop checkout module. */
export function checkoutReady() {
  return [users, db, format, reviews, search].length;
}
