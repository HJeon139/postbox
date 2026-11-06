import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as coupons from './coupons.mjs';
import * as shipping from './shipping.mjs';

/** The shop payments module. */
export function paymentsReady() {
  return [db, format, logger, coupons, shipping].length;
}
