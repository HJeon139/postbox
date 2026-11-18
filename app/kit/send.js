// Inlined after the kit in every app page:
//   postbox.send(action, values, summary)  sends one event to the agent. Postbox writes the line in your voice from
//                                 what was sent; summary shows beside it as the app’s own words (#51). The
//                                 person’s click or key press in the app starts one turn; any other send (on
//                                 load, on a timer, the rest of one click’s burst) resolves { ok, noted: true }:
//                                 a note the agent reads with read_app, no turn (#1488). Values larger
//                                 than one event carries (eventBytes in shared/limits.mjs, which the server
//                                 passes in data-init) reject here, with the limit named, and nothing is sent
// Its own script beside the kit, which is at its length limit, as app/kit/publish.js is; it answers on the kit’s reply
// messages by its own ids.
(function () {
  const init = JSON.parse(document.querySelector('script[data-init]')?.dataset.init || '{}');
  const pending = new Map();
  let seq = 0;
  addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== parent || m?.__pb !== 1 || m.type !== 'reply' || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  });
  // includeUserActivation: the browser attaches this frame’s own click or key press state to the message, which
  // is how Postbox knows a send came from the person using the app (the app can’t set it itself).
  const call = (payload) =>
    new Promise((resolve, reject) => {
      const id = `send-${++seq}`;
      pending.set(id, { resolve, reject });
      parent.postMessage(Object.assign({ __pb: 1, appId: init.appId, version: init.version, type: 'event', id }, payload), {
        targetOrigin: '*',
        includeUserActivation: true,
      });
    });
  window.postbox.send = (action, values, summary) => {
    if (init.check) return Promise.resolve({ ok: true, skipped: true });
    const v = Object.assign({}, values || {});
    if (summary) v.summary = summary;
    // Too large for one event: say so inside the app, before anything is posted, rather than lose it (#50).
    const max = init.limits?.eventBytes;
    let size = 0;
    try {
      size = JSON.stringify(v).length;
    } catch {
      // Not plain JSON: Postbox refuses it, and says so.
    }
    if (max && size > max) {
      const kb = (n) => `${Math.ceil(n / 1024).toLocaleString('en-US')} KB`;
      return Promise.reject(
        new Error(
          `postbox.send: these values are ${kb(size)} as JSON, larger than the ${kb(max)} one event can carry, so nothing was sent. Send ids instead, and look the items up from them.`,
        ),
      );
    }
    return call({ action, values: v });
  };
})();
