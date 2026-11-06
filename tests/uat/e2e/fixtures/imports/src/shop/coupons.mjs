import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as orders from './orders.mjs';
import * as payments from './payments.mjs';

/** The shop coupons module. */
export function couponsReady() {
  return [db, format, logger, orders, payments].length;
}
