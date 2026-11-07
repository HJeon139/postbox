// Why an automatic install the consent withdrew before it started didn’t run (hosts-update.mjs’s noteStarted). Known by
// its words: hosts.mjs and hosts-links.mjs tell it from other failures by them. Its own module, so hosts-links.mjs reads
// it without importing hosts-update.mjs, which imports it (#312).

export const WITHDRAWN = 'Keeping Postbox up to date on this host was turned off, so Postbox didn’t install by itself.';
