import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as audit from './audit.mjs';
import * as reports from './reports.mjs';

/** The admin refunds module. */
export function refundsReady() {
  return [audit, reports, db, format].length;
}
