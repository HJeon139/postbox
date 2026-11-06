import * as format from '../lib/format.mjs';
import * as account from './account.mjs';
import * as wishlist from './wishlist.mjs';

/** The shop emails module. */
export function emailsReady() {
  return [format, account, wishlist].length;
}
