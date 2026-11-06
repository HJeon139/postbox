import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as inventory from './inventory.mjs';
import * as reports from './reports.mjs';

/** The admin settings module. */
export function settingsReady() {
  return [inventory, reports, db, format].length;
}
