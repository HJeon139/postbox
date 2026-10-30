// An event’s JSON, checked against what the store’s Redis would refuse before the store applies it (shared/storable.mjs;
// the integrator’s review of #553, blocker 2). Both emit (server/store.mjs) and commit (server/store-commit.mjs) take
// an event’s line from here.

import { EVENT_DEPTH, storable, wellFormed } from '../shared/storable.mjs';
import { storeError } from './redis-client.mjs';

const EVENT_LIMITS = { jsonDepth: EVENT_DEPTH };

/**
 * An event’s data as JSON, once the store’s Redis would take it (shared/storable.mjs): one nested past the limit is
 * refused to the caller, before anything is applied or broadcast; a string cut inside a character, which Postbox’s own
 * cuts to a length can make, is repaired in place, so the state, the browsers and Redis hold the same text.
 * @param {string} type @param {any} data
 */
export function storableLine(type, data) {
  let json = JSON.stringify(data);
  const why = storable(json, EVENT_LIMITS);
  if (!why) return json;
  if (!why.cut) throw storeError('EUNSTORABLE', `Postbox didn’t make this change, since it can’t store it. ${why.message}`);
  console.error(`A ${type} event held half of a character, which the store can’t keep; Postbox replaced it with U+FFFD.`);
  json = JSON.stringify(wellFormed(data));
  const still = storable(json, EVENT_LIMITS);
  if (still) throw storeError('EUNSTORABLE', `Postbox didn’t make this change, since it can’t store it. ${still.message}`);
  return json;
}
