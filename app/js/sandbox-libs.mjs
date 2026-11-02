// What sandboxed pages, apps (apps.mjs) and diagrams (md-enhance.mjs), get from the page: its theme, and the bundled
// libraries as text, which they run inline (see kit.js). KaTeX’s fonts travel inside its stylesheet as data: URLs,
// since the page can’t fetch them either.

export const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

const LIB_FILES = { d3: 'd3/d3.min.js', katex: 'katex/katex.min.js', mermaid: 'mermaid/mermaid.min.js' };
const libCache = new Map();
export function libSource(name) {
  if (!LIB_FILES[name]) return Promise.reject(new Error(`There’s no bundled library called “${name}”.`));
  if (!libCache.has(name)) {
    const text = (path) =>
      fetch(`/kit/vendor/${path}`).then((r) => {
        if (!r.ok) throw new Error(`Couldn’t load ${path}.`);
        return r;
      });
    const css =
      name === 'katex'
        ? text('katex/katex.min.css')
            .then((r) => r.text())
            .then(inlineFonts)
        : Promise.resolve(null);
    const p = Promise.all([text(LIB_FILES[name]).then((r) => r.text()), css]).then(([js, c]) => ({ js, css: c }));
    p.catch(() => libCache.delete(name));
    libCache.set(name, p);
  }
  return libCache.get(name);
}
async function inlineFonts(css) {
  const files = [...new Set([...css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)].map((m) => m[1]))];
  const data = new Map();
  await Promise.all(
    files.map(async (f) => {
      const buf = new Uint8Array(await (await fetch(`/kit/vendor/katex/fonts/${f}`)).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      data.set(f, `data:font/woff2;base64,${btoa(bin)}`);
    }),
  );
  // Keep the woff2 source of each font face, as a data: URL, and drop the woff and ttf fallbacks.
  return css.replace(
    /url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g,
    (_m, f) => `url(${data.get(`${f}.woff2`)}) format('woff2')`,
  );
}
