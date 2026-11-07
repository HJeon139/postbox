// Going to a conversation the page may not have yet (#926). New conversation, Attach a session and New agent in a new
// conversation each make one through the API, then go to it; its own `thread` event can reach the page after that,
// and an address naming a conversation the page doesn’t have goes to the start (main.mjs). So they wait for it here,
// and go once the page has it. The API has said it exists, so it lands; the person going elsewhere first ends the wait.

import { client, S } from './client.mjs';
import { navigate } from './ui.mjs';

/**
 * Goes to the conversation `find` names, now if the page has it, else when an event brings it.
 * @param {(state: any) => string | null | undefined} find  the conversation’s id once the page has it, else nothing
 * @returns {() => void}  stops waiting
 */
export function goWhenThere(find) {
  const now = find(S());
  if (now) {
    navigate(`#/t/${now}`);
    return () => {};
  }
  const from = location.hash;
  const stop = () => {
    stopListening();
    removeEventListener('hashchange', moved);
  };
  // The person went elsewhere first: the conversation is still made, and they find it in the rail.
  const moved = () => {
    if (location.hash !== from) stop();
  };
  const stopListening = client.on((change) => {
    if (change.type !== 'thread' && change.type !== 'session' && change.type !== 'load') return;
    const id = find(S());
    if (!id) return;
    stop();
    navigate(`#/t/${id}`);
  });
  addEventListener('hashchange', moved);
  return stop;
}

/** @param {string} threadId  a conversation the API just made */
export const goToNew = (threadId) => goWhenThere((s) => (s.threads[threadId] ? threadId : null));
