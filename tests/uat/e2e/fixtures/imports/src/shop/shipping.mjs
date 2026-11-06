import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as checkout from './checkout.mjs';
import * as wishlist from './wishlist.mjs';

/** The shop shipping module. */
export function shippingReady() {
  return [db, format, logger, checkout, wishlist].length;
}
