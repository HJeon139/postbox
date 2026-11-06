import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as coupons from './coupons.mjs';
import * as payments from './payments.mjs';

/** The shop search module. */
export function searchReady() {
  return [db, format, coupons, payments].length;
}
