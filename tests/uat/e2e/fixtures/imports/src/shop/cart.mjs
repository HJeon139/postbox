import * as format from '../lib/format.mjs';
import * as logger from '../lib/logger.mjs';
import * as payments from './payments.mjs';
import * as reviews from './reviews.mjs';

/** The shop cart module. */
export function cartReady() {
  return [format, logger, payments, reviews].length;
}
