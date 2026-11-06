import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as csvExport from './csv-export.mjs';
import * as reports from './reports.mjs';

/** The admin audit module. */
export function auditReady() {
  return [csvExport, reports, db, format].length;
}
