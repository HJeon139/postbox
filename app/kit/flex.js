// Prototype (designs/prototypes/flexible-apps.md), inlined after the kit in every app page:
//   postbox.publish(data)  → Promise; data the app shares with its agent, which reads it with read_app and hears at
//                            its next turn that it changed. No turn, no card, no line in the person’s voice.
// and web links that open in a new tab, as a normal page with no way back to this one, rather than replacing the app,
// and only when the person clicked them.
(function () {
  const check = document.documentElement.querySelector('script[data-init]');
  const init = JSON.parse(check?.dataset.init || '{}');
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
  window.postbox.publish = (data) => {
    if (init.check) return Promise.resolve({ ok: true, skipped: true });
    const id = `publish-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ __pb: 1, appId: init.appId, version: init.version, type: 'publish', id, data }, '*');
    });
  };
  // A web link asks Postbox to open it in a new tab. Postbox does only right after a click or key press in this app
  // (the same check as postbox.send), so an app can’t send the person anywhere on its own.
  addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || !/^https?:/i.test(a.href) || e.defaultPrevented) return;
    e.preventDefault();
    parent.postMessage({ __pb: 1, appId: init.appId, version: init.version, type: 'open', url: a.href }, { targetOrigin: '*', includeUserActivation: true });
  });
})();
