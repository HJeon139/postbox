import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as coupons from './coupons.mjs';
import * as orders from './orders.mjs';

/** The shop catalog module. */
export function catalogReady() {
  return [db, format, coupons, orders].length;
}
