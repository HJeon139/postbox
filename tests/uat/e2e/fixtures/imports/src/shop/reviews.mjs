import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as account from './account.mjs';
import * as search from './search.mjs';

/** The shop reviews module. */
export function reviewsReady() {
  return [db, format, account, search].length;
}
