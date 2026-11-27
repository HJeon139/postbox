// A hosted Postbox’s settings file (designs/architecture/hosted.md, “One system, and the difference is at the edge”):
// what `postbox --hosted <file>` reads. It says two things about the deployment and nothing about who anyone is: the
// one public origin people reach it at, and how to tell who signed in (server/identity/sign-in-settings.mjs). A
// Postbox started without it is the one on your own computer, unchanged.

import { readFileSync } from 'node:fs';
import { fetchKeyText } from './identity/alb-key-fetch.mjs';
import { signInSettings } from './identity/sign-in-settings.mjs';

/**
 * The origin as browsers write it, or a refusal that says what to set. HTTPS only: the load balancer signs people in
 * only on an HTTPS listener, and the page’s token cookie is sent only over one.
 * @param {unknown} given
 */
export function publicOriginOf(given) {
  const wrong = () =>
    new Error('Hosted settings need “origin”: the one address people open this Postbox at, such as https://postbox.example.com, with no path.');
  if (typeof given !== 'string' || !URL.canParse(given)) throw wrong();
  const url = new URL(given);
  // As a browser sends it back in `Origin`, so the two compare as text: lowercase, no path, no default port.
  if (url.protocol !== 'https:' || url.origin !== given) throw wrong();
  return url.origin;
}

/**
 * What `start()` is given for a hosted Postbox, from the settings file’s path.
 * @param {string} path
 * @returns {{ host: string, publicOrigin: string, signIn: import('./identity/index.mjs').SignIn }}
 *   host: every address of the container, since the load balancer reaches it on the container’s own
 */
export function readHosted(path) {
  let given;
  try {
    given = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Postbox couldn’t read the hosted settings at ${path}: ${e.message}`, { cause: e });
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new Error('Hosted settings are an object with “origin” and “signIn”.');
  for (const key of Object.keys(given))
    if (key !== 'origin' && key !== 'signIn') throw new Error(`Hosted settings have no “${key}”. They have: origin, signIn.`);
  const publicOrigin = publicOriginOf(given.origin);
  signInSettings(given.signIn); // refused here in words, before anything starts
  return { host: '0.0.0.0', publicOrigin, signIn: { settings: given.signIn, get: fetchKeyText } };
}
