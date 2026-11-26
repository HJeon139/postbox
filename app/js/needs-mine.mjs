// Whose a need is, on the page (#1742): what an agent needs of a person rings that person alone, so a page asks whether
// a need is its viewer’s before it pulses a ring, counts it, goes to it or raises a toast. A need that names no one is
// everyone’s, as every need was before Postbox knew people (shared/needs.mjs, needsYouNow).

import { needsYouNow } from '/shared/needs.mjs';
import { client } from './client.mjs';

/** The one looking, by their person id (#558). */
export const meId = () => client.config?.me?.id;

/** Whether an agent needs the one looking. @param {any} se */
export const needsMe = (se) => needsYouNow(se, meId());

/** Whether an agent needs a person who isn’t the one looking: its state shows, and nothing rings here. @param {any} se */
export const needsAnother = (se) => needsYouNow(se) && !needsMe(se);
