import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as audit from './audit.mjs';
import * as csvExport from './csv-export.mjs';

/** The admin inventory module. */
export function inventoryReady() {
  return [audit, csvExport, format, logger].length;
}
