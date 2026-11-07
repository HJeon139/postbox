import { BASE_DELAY_MS, MAX_DELAY_MS } from './config.mjs';

/** How long to wait before trying again after the given attempt failed: 30 s, 1 min, 2 min, 4 min, plus up to a fifth more. */
export function retryDelay(attempt, random = Math.random) {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(delay * (1 + random() / 5));
}
