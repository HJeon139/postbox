import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as refunds from './refunds.mjs';
import * as users from './users.mjs';

/** The admin imports module. */
export function importsReady() {
  return [refunds, users, db, format].length;
}
