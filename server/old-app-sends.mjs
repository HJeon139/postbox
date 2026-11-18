// Old data folders, from before #1488, can hold `appsend` items: the card that held an app’s sends for the person to
// allow, which Postbox no longer makes, since a click’s send starts its turn and any other is a note. This is all that’s
// left of it, so such a folder still loads. At startup each one still open is closed, so nothing waits on the person,
// and each gets a plain line the page shows as it shows any item of a kind it no longer draws (app/js/thread.mjs).
// card-needs.mjs no longer knows the kind, so none makes anyone need you, and a need saved for one is settled by the
// restart sweep (restart-sweep.mjs, settleRetiredNeeds).

const KIND = 'appsend';

/** @param {any} rt */
export function closeOldSendCards(rt) {
  for (const [threadId, list] of Object.entries(rt.s.items))
    for (const it of list) {
      if (it.kind !== KIND || (it.status !== 'open' && typeof it.text === 'string')) continue;
      const n = Array.isArray(it.events) ? it.events.length : 1;
      const text = `${it.title ?? 'An app'} asked to send ${n === 1 ? '1 message' : `${n} messages`} for you, in an older Postbox. Nothing waits on it.`;
      rt.threads.patchItem(threadId, it.id, { ...(it.status === 'open' ? { status: 'declined' } : {}), text });
    }
}
