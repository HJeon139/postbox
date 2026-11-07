// An app writes lines in your voice, and each one starts an agent turn, so its sends are limited (#38). The
// browser accepts a send only right after a click or key press in that app (app/js/apps.mjs); here, where a
// script calling the API lands too, an app gets APP_SEND_LIMIT sends per APP_SEND_WINDOW_MS. More wait on
// a card for you to allow or not, and nothing is dropped silently: the app is told its send is waiting.
// The browser keeps the same limit (SEND_LIMIT in app/js/app-send-card.mjs), and the agent guide says so.
// Its own module, so apps.mjs and card-needs.mjs both read it without importing each other (#312).

export const APP_SEND_LIMIT = 5;
export const APP_SEND_WINDOW_MS = 60_000;
/** Sends one card holds; past that, a send is refused with a reason. */
export const APP_HOLD_MAX = 20;
