// Resolves the color mode before first paint. Preference is System, Light or Dark.
// The real app keeps the preference in its own store; mockups read ?theme= or localStorage.
(function () {
  var q = new URLSearchParams(location.search);
  var pref = q.get('theme');
  try { if (!pref) pref = localStorage.getItem('pb-theme'); } catch (e) {}
  pref = pref || 'system';
  var sys = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = pref === 'system' ? sys : pref;
  if (q.has('shot')) document.documentElement.classList.add('shot');
})();
