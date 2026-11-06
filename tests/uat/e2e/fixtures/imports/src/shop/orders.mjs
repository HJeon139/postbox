import * as reports from '../admin/reports.mjs';
import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as catalog from './catalog.mjs';
import * as shipping from './shipping.mjs';

/** The shop orders module. */
export function ordersReady() {
  return [reports, db, format, catalog, shipping].length;
}
