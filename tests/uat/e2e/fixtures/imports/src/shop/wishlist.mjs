import * as format from '../lib/format.mjs';
import * as cart from './cart.mjs';
import * as emails from './emails.mjs';

/** The shop wishlist module. */
export function wishlistReady() {
  return [format, cart, emails].length;
}
