// Inlined after the kit in every app page (#1480): a web link the person clicks opens in a new tab, rather than in the
// app’s own frame, which can’t leave its page. The kit hands it to Postbox, which opens it only right after a click or
// key press in this app (the same check as postbox.send), so an app can’t send the person anywhere on its own. The page
// has no allow-popups: in the Claude desktop app’s pane, a popup replaced Postbox’s own page.
(function () {
  const init = JSON.parse(document.querySelector('script[data-init]')?.dataset.init || '{}');
  addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || !/^https?:/i.test(a.href)) return;
    e.preventDefault();
    parent.postMessage(
      { __pb: 1, appId: init.appId, version: init.version, type: 'open', url: a.href },
      { targetOrigin: '*', includeUserActivation: true },
    );
  });
})();
