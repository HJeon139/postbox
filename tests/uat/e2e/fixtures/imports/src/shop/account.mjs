import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as cart from './cart.mjs';
import * as payments from './payments.mjs';

/** The shop account module. */
export function accountReady() {
  return [db, format, logger, cart, payments].length;
}
