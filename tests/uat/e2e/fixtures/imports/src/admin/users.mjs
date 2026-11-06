import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as audit from './audit.mjs';
import * as imports from './imports.mjs';

/** The admin users module. */
export function usersReady() {
  return [audit, imports, db, format].length;
}
