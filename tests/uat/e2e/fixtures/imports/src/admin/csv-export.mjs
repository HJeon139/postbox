import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as audit from './audit.mjs';
import * as dashboard from './dashboard.mjs';

/** The admin csv export module. */
export function csvExportReady() {
  return [audit, dashboard, db, format].length;
}
