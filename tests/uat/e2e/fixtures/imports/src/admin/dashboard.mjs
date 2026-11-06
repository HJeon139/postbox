import * as db from '../lib/db.mjs';
import * as format from '../lib/format.mjs';
import * as audit from './audit.mjs';
import * as users from './users.mjs';

/** The admin dashboard module. */
export function dashboardReady() {
  return [audit, users, db, format].length;
}
