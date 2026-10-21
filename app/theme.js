// Resolves the color mode before first paint, from the last choice saved in this browser.
// The choice itself lives in Postbox's store; main.mjs applies it once the state loads.
(function () {
  var pref = 'system';
  try {
    pref = localStorage.getItem('pb-theme') || 'system';
  } catch (_e) {}
  var sys = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = pref === 'system' ? sys : pref;
})();
