import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as orders from '../shop/orders.mjs';
import * as csvExport from './csv-export.mjs';
import * as imports from './imports.mjs';

/** The admin reports module. */
export function reportsReady() {
  return [csvExport, imports, db, format, logger, orders].length;
}
