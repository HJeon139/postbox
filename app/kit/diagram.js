// Renders one Mermaid diagram inside its sandbox page. Postbox sends the source with postMessage;
// this page answers with its height. Mermaid runs with strict security, so diagram text can’t add
// links or script.
(function () {
  'use strict';
  const out = document.getElementById('out');
  const post = (m) => parent.postMessage(Object.assign({ __pbd: 1 }, m), '*');
  let n = 0;
  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.__pbd !== 1 || e.data.type !== 'render') return;
    const light = document.documentElement.dataset.theme === 'light';
    const css = getComputedStyle(document.documentElement);
    const v = (k) => css.getPropertyValue(k).trim();
    try {
      window.mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: 'system-ui, sans-serif',
        themeVariables: { background: v('--sunk'), primaryColor: v('--panel'), primaryTextColor: v('--text'), primaryBorderColor: v('--line-strong'),
          lineColor: v('--dim'), secondaryColor: v('--chip'), tertiaryColor: v('--sunk'), edgeLabelBackground: v('--sunk'), fontSize: '13px', darkMode: !light },
      });
      const { svg } = await window.mermaid.render('d' + ++n, String(e.data.src));
      out.innerHTML = svg;
      out.setAttribute('aria-label', e.data.label || 'Diagram');
    } catch (err) {
      out.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'err';
      p.textContent = 'This diagram couldn’t be drawn: ' + (err && err.message ? err.message.split('\n')[0] : 'unknown error') + '. Its source is still available.';
      out.appendChild(p);
    }
    requestAnimationFrame(() => post({ type: 'size', height: Math.ceil(document.documentElement.scrollHeight) }));
  });
  post({ type: 'ready' });
})();
