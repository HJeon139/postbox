// Inlined after the kit in every app page (#1478):
//   postbox.publish(data)  → Promise; data the app shares with its agent, which reads it with read_app and hears at its
//                            next turn that it changed. No turn, no card, no line in the person’s voice.
// Its own script beside the kit, which is at its length limit; it answers on the kit’s reply messages by its own ids.
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
  window.postbox.publish = (data) => {
    // The pre-display check runs the app too, in hidden frames: what it publishes isn’t the person’s.
    if (init.check) return Promise.resolve({ ok: true, skipped: true });
    const id = `publish-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ __pb: 1, appId: init.appId, version: init.version, type: 'publish', id, data }, '*');
    });
  };
})();
