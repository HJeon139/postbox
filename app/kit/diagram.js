// Renders one Mermaid diagram inside its sandbox page. Postbox sends the source with postMessage;
// this page answers with its height. Mermaid runs with strict security, so diagram text can’t add
// links or script.
(function () {
  const out = document.getElementById('out');
  const post = (m) => parent.postMessage(Object.assign({ __pbd: 1 }, m), '*');
  let n = 0;
  // Errors in here are invisible from outside the sandbox, so they’re reported to Postbox, which logs them.
  addEventListener('error', (e) => post({ type: 'error', message: String(e.message || e.error) }));
  addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String(e.reason?.message || e.reason) }));
  addEventListener('securitypolicyviolation', (e) => post({ type: 'error', message: `Blocked by ${e.violatedDirective}: ${e.blockedURI}` }));
  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.__pbd !== 1 || e.data.type !== 'render') return;
    // Mermaid arrives with the first diagram and runs as an inline script; the page loads no files.
    if (!window.mermaid && e.data.lib) {
      const s = document.createElement('script');
      s.textContent = e.data.lib;
      document.head.appendChild(s);
    }
    const light = document.documentElement.dataset.theme === 'light';
    const css = getComputedStyle(document.documentElement);
    const v = (k) => css.getPropertyValue(k).trim();
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: 'system-ui, sans-serif',
        themeVariables: {
          background: v('--sunk'),
          primaryColor: v('--panel'),
          primaryTextColor: v('--text'),
          primaryBorderColor: v('--line-strong'),
          lineColor: v('--dim'),
          secondaryColor: v('--chip'),
          tertiaryColor: v('--sunk'),
          edgeLabelBackground: v('--sunk'),
          fontSize: '13px',
          darkMode: !light,
        },
      });
      const { svg } = await window.mermaid.render('d' + ++n, String(e.data.src));
      out.innerHTML = svg; // lint-allow dom: Mermaid’s own SVG, rendered with securityLevel strict in this sandboxed frame.
      out.setAttribute('aria-label', e.data.label || 'Diagram');
    } catch (err) {
      out.replaceChildren();
      const p = document.createElement('p');
      p.className = 'err';
      p.textContent = 'This diagram couldn’t be drawn: ' + (err?.message ? err.message.split('\n')[0] : 'unknown error') + '. Its source is still available.';
      out.appendChild(p);
    }
    requestAnimationFrame(() => {
      // The diagram is scaled to fit; its text ends up at fontSize × (shown width ÷ natural width).
      const svg = out.querySelector('svg');
      const natural = svg?.viewBox?.baseVal?.width;
      const shown = svg?.getBoundingClientRect().width;
      const textPx = natural && shown ? Math.round(13 * Math.min(1, shown / natural) * 10) / 10 : null;
      post({ type: 'size', height: Math.ceil(document.documentElement.scrollHeight), textPx, width: document.documentElement.clientWidth });
    });
  });
  post({ type: 'ready' });
})();
