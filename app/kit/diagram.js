// Renders one Mermaid diagram inside its sandbox page. Postbox sends the source with postMessage;
// this page answers with its height. Mermaid runs with strict security, so diagram text can’t add
// links or script.

// Mermaid reads a label as Markdown, so one that starts like a block, a list item (“1. Build”, “2) Test”, “- Lint”), a
// heading (“# of users”), a quote or a rule (“---”), can’t be drawn: it reads “Unsupported markdown: list” (#684). A
// word joiner (U+2060), which draws as nothing, before the mark keeps it text. A backslash would too, but after “[”
// it opens Mermaid’s slanted shape.

// Where a label starts, each its own piece of the pattern:
const SHAPE = '[[(]'; // a shape’s opening bracket or parenthesis
const SLANTED = String.raw`\[[/\\]`; // a slanted shape’s “[/” or “[\”
const BRACE = '{'; // a rhombus; in a class diagram, a member list, whose “+” and “-” mark public and private
const ASYMMETRIC = '(?<![-=.>])>(?!>)'; // an asymmetric shape’s “>”, never an arrow’s head (“->>+ B”) or “>>”
const EDGE_BAR = String.raw`\|`; // an edge label’s bar
const EDGE_TEXT = String.raw`(?<![-=.<])(?:--|==|-\.)(?![-=.>])`; // the “--”, “==” or “-.” that opens an edge’s text
const COLON = ':'; // a state’s or a transition’s label, or a class relation’s
const STATE_NAME = String.raw`\bstate[ \t]+(?![ \t])`; // state "1. Build" as s1
const NOTE = String.raw`\bnote(?:[ \t]+for[ \t]+(?:\x60[^\x60\n]*\x60|[^\s"]+))?[ \t]*(?![ \t])`; // a class diagram’s note “1. note”, or note for A “…”
const QUOTED = String.raw`(?:"\x60|["\x60])?`; // then a quote, or a quote and a backtick for a Markdown string
// What Mermaid reads as a block there: a list item, a heading or a quote, then a space; or a rule, alone.
const BLOCK = String.raw`(?:(?:\d{1,9}[.)]|[-*+]|#{1,6}|>)[ \t]|(?:-{3,}|\*{3,}|_{3,})[ \t]*(?=["\x60\])}|/\\\n]|$))`;
const labelStart = (...openers) => new RegExp(String.raw`((?:${openers.join('|')})${QUOTED}[ \t]*)(?=${BLOCK})`, 'g');
const LABEL_START = labelStart(SHAPE, SLANTED, BRACE, ASYMMETRIC, EDGE_BAR, EDGE_TEXT, COLON, STATE_NAME);
// A class diagram has no bar or edge-text labels and no asymmetric shapes, and its arrows (“--|>”, “--*”) and
// annotations (“<<interface>>”) would read as openers. A colon opens a label only after a relation, an arrow before the
// colon (“A --> B : 1. uses”); after a bare class name (“Build : - String name”), and in braces, the mark sets a
// member’s visibility.
const CLASS_START = labelStart(SHAPE, STATE_NAME, NOTE);
const RELATION_START = labelStart(SHAPE, COLON, STATE_NAME, NOTE);
const RELATION = /^[^:]*(?:--|\.\.)[^:]*:/;
// A Markdown string (“`…`” in quotes) can run over lines, and each of its lines can start like a block too.
const MARKDOWN_STRING = /"`([^`]*)`"/g;
const LINE_START = new RegExp(String.raw`(^|\n)([ \t]*)(?=${BLOCK})`, 'g');
// A state diagram’s note over lines, “note right of s1” to the first “end note”, in any case as Mermaid reads it:
// each line is a label’s start too.
const NOTE_OPEN = /^[ \t]*note[ \t]+(?:left|right)[ \t]+of[ \t]+[^\s:][^:]*$/i;
const NOTE_END = /end note\b/i;
/** A state diagram’s note bodies kept as text, in one pass over its lines. @param {string} text */
function stateNotes(text) {
  let inNote = false;
  return text
    .split('\n')
    .map((line) => {
      if (!inNote) {
        inNote = NOTE_OPEN.test(line);
        return line;
      }
      if (NOTE_END.test(line)) inNote = false;
      return line.replace(LINE_START, '$1$2\u2060');
    })
    .join('\n');
}
const JOINED = '$1\u2060';
/**
 * The diagram’s type, as Mermaid reads it: the first word of its first line after any frontmatter, directives, blank
 * lines and “%%” comments. Never a word further down, such as a class member named “stateDiagram”.
 * @param {string} src
 */
function diagramType(src) {
  const lines = src.split('\n');
  let k = 0;
  // Frontmatter: a first line of “---”, to the next.
  if (lines[0]?.trim() === '---') {
    k = lines.findIndex((l, n) => n > 0 && l.trim() === '---') + 1;
    if (k === 0) return '';
  }
  // Then directives (“%%{init: …}%%”, which can run over lines), comments and blank lines, in one pass.
  let directive = false;
  for (; k < lines.length; k++) {
    const t = lines[k].trim();
    if (directive || t.startsWith('%%{')) directive = !t.includes('}%%');
    else if (t && !t.startsWith('%%')) return t.split(/[\s{]/)[0];
  }
  return '';
}

/** The source with every label that starts like a block kept as text. @param {string} src */
function asWritten(src) {
  const strings = src.replace(MARKDOWN_STRING, (_m, body) => '"`' + body.replace(LINE_START, '$1$2\u2060') + '`"');
  // Only a state diagram has these notes: in a class diagram, “- field” after such a line is a private member.
  const type = diagramType(src);
  const text = type.startsWith('stateDiagram') ? stateNotes(strings) : strings;
  if (!type.startsWith('classDiagram')) return text.replace(LABEL_START, JOINED);
  return text
    .split('\n')
    .map((line) => line.replace(RELATION.test(line) ? RELATION_START : CLASS_START, JOINED))
    .join('\n');
}

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
      const { svg } = await window.mermaid.render('d' + ++n, asWritten(String(e.data.src)));
      out.innerHTML = svg; // lint-allow dom: Mermaid’s own SVG, rendered with securityLevel strict in this sandboxed frame.
      out.setAttribute('aria-label', e.data.label || 'Diagram');
    } catch (err) {
      out.replaceChildren();
      const p = document.createElement('p');
      p.className = 'err';
      p.textContent = 'This diagram couldn’t be drawn: ' + (err?.message ? err.message.split('\n')[0] : 'unknown error') + '. Its source is still available.';
      out.appendChild(p);
      // Mermaid’s own message and line go to Postbox, which tells the agent so it can fix the diagram.
      const message = String(err?.message || err || 'unknown error').slice(0, 1000);
      const line = err?.hash?.loc?.first_line ?? +(/line (\d+)/i.exec(message)?.[1] ?? 0);
      post({ type: 'error', render: true, message, line: line || null });
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
