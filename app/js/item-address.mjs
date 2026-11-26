// A message’s address (#168): its thread’s, with m= naming it (route(), ui.mjs). Opened, a reload, Back and a pasted link
// all land on the message (focusAddressed, needs-nav.mjs).

import { hrefOf } from './client.mjs';

/** A message’s address in the page. @param {string} threadId @param {string} itemId */
export const itemHref = (threadId, itemId) => `${hrefOf(threadId)}?m=${encodeURIComponent(itemId)}`;

/** A message’s whole address, to share: a message’s Copy link gives it. @param {string} threadId @param {string} itemId */
export const itemLink = (threadId, itemId) => new URL(itemHref(threadId, itemId), location.href).href;
