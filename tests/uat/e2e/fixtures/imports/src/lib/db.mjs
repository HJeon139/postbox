import * as config from './config.mjs';

/** The lib db module. */
export function dbReady() {
  return [config].length;
}
