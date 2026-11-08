// Calibrating the side-by-side judge (#995) before its picks count. Each pair is two runs’ first pictures for the same
// question, one from a scenario with Postbox’s skill and one from its `-base` twin. The maintainer judges them blind
// on a page: the person, their question, and the two screenshots, each with what it was meant to say, in an order of
// the page’s own. The model judge is shown exactly that. agreement() compares their picks.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '../../shared/markdown.mjs';
import { meantLabel } from './side-by-side.mjs';

/**
 * Pairs a scenario’s runs with its `-base` twin’s, newest first, taking one pair from each scenario in turn, up to `n`.
 * @param {{ run: string, scenario: string, picture: any }[]} runs  each with a first picture
 * @param {number} n
 */
export function twinPairs(runs, n) {
  const byScenario = new Map();
  for (const r of [...runs].sort((a, b) => b.run.localeCompare(a.run))) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r);
  }
  const queues = [...byScenario.keys()]
    .filter((s) => !s.endsWith('-base') && byScenario.has(`${s}-base`))
    .sort()
    .map((s) => ({ skill: [...byScenario.get(s)], base: [...byScenario.get(`${s}-base`)] }));
  const pairs = [];
  while (pairs.length < n && queues.some((q) => q.skill.length && q.base.length)) {
    for (const q of queues) {
      if (pairs.length < n && q.skill.length && q.base.length) pairs.push({ skill: q.skill.shift(), base: q.base.shift() });
    }
  }
  return pairs;
}

/** One side: its picture, and the sentence it was meant to say, introduced for what it is. */
const sideHtml = (name, file, side) => {
  const said = side.intent ? `: “${escapeHtml(side.intent)}”` : '.';
  return `<section class="side"><h3>Picture ${name}</h3><img src="${file}" alt="Picture ${name}, as it was on screen"><p class="meant"><span class="dim">${escapeHtml(meantLabel(side))}</span>${said}</p></section>`;
};

/** One pair’s card. @param {{ persona: string, question: string, sides: any[] }} p @param {number} n */
function card(p, n) {
  const choice = ['A', 'B', 'tie']
    .map((v) => `<label><input type="radio" name="p${n}" value="${v}"> ${v === 'tie' ? 'Neither' : `Picture ${v}`}</label>`)
    .join('');
  return `<article class="pair" data-n="${n}">
<h2>Pair ${n}</h2>
<p class="who">${escapeHtml(p.persona)}</p>
<p class="ask">They asked: “${escapeHtml(p.question)}”</p>
<div class="sides">${sideHtml('A', `${n}-a.png`, p.sides[0])}${sideHtml('B', `${n}-b.png`, p.sides[1])}</div>
<fieldset><legend>As this person, which picture leaves you understanding more?</legend>${choice}
<input type="text" class="note" aria-label="Why, in a few words (optional)" placeholder="Why, in a few words (optional)"></fieldset>
</article>`;
}

const STYLE = `:root{--bg:#fbfaf7;--panel:#fff;--text:#1d1d1b;--dim:#5d5b55;--line:#dedbd2;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--panel:#252523;--text:#ecebe6;--dim:#a9a69c;--line:#3b3a36;--accent:#8fb0ff}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px}
.pair{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
.who,.dim{color:var(--dim)}.ask{font-weight:600}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:800px){.sides{grid-template-columns:1fr}}
.side{border:1px solid var(--line);border-radius:6px;padding:12px}
.side img{max-width:100%;border:1px solid var(--line)}
fieldset{border:0;padding:8px 0 0;display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.note{flex:1;min-width:200px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px}
button{font:inherit;padding:8px 16px;background:var(--accent);color:#fff;border:0;border-radius:6px;cursor:pointer}
textarea{width:100%;height:120px;font:13px ui-monospace,monospace;background:var(--panel);color:var(--text);border:1px solid var(--line)}`;

// Saves the picks as picks.json, and shows them to copy; keeps them in this browser meanwhile, where it can.
const SCRIPT = `const pairs=[...document.querySelectorAll('.pair')];
const read=()=>({picks:pairs.map((a)=>({n:Number(a.dataset.n),pick:a.querySelector('input[type=radio]:checked')?.value??null,note:a.querySelector('.note').value}))});
const keep=()=>{try{localStorage.setItem('picks-995-pictures',JSON.stringify(read()))}catch{}};
try{const had=JSON.parse(localStorage.getItem('picks-995-pictures')??'null');for(const p of had?.picks??[]){const a=pairs.find((x)=>Number(x.dataset.n)===p.n);if(!a)continue;if(p.pick)a.querySelector('input[value="'+p.pick+'"]').checked=true;a.querySelector('.note').value=p.note??''}}catch{}
document.addEventListener('change',keep);document.addEventListener('input',keep);
document.getElementById('save').addEventListener('click',()=>{const json=JSON.stringify(read(),null,2);document.getElementById('out').value=json;
const left=read().picks.filter((p)=>!p.pick).length;document.getElementById('left').textContent=left?left+' pairs have no pick yet.':'Every pair has a pick.';
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([json],{type:'application/json'}));a.download='picks.json';a.click();});`;

/**
 * Copies each pair’s pictures into `out` as <n>-a.png and <n>-b.png and writes the page.
 * @param {{ persona: string, question: string, sides: { file: string, intent: string, intentFrom: string|null }[] }[]} pairs
 *   sides: A’s and B’s, with their screenshot’s path
 * @param {string} out
 */
export function calibrationPage(pairs, out) {
  mkdirSync(out, { recursive: true });
  pairs.forEach((p, i) => {
    copyFileSync(p.sides[0].file, join(out, `${i + 1}-a.png`));
    copyFileSync(p.sides[1].file, join(out, `${i + 1}-b.png`));
  });
  const cards = pairs.map((p, i) => card(p, i + 1)).join('\n');
  writeFileSync(
    join(out, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Picture against picture</title><style>${STYLE}</style></head><body><main>
<h1>Picture against picture: ${pairs.length} pairs</h1>
<p class="dim">Each pair is two agents’ first pictures for one person’s question, each with the sentence it was meant to say. Pick the picture that leaves that person understanding more, judging what the drawing shows and whether it says what it meant to. Pick Neither when they help equally. The order is random.</p>
${cards}
<p><button id="save" type="button">Save my picks</button> <span id="left" class="dim"></span></p>
<p class="dim">This saves picks.json. Send it back, or paste what’s below.</p>
<textarea id="out" readonly aria-label="Your picks as JSON"></textarea>
</main><script>${SCRIPT}</script></body></html>
`,
  );
}

/**
 * The judge’s agreement with the maintainer’s picks, as skill, base or tie: how often they picked the same, and Cohen’s
 * κ, which discounts what two judges would agree on by chance. Pairs without a pick are left out.
 * @param {{ n: number, skillAs: 'A'|'B', judge: { pick: string } }[]} key @param {{ picks: { n: number, pick: string|null }[] }} answers
 */
export function agreement(key, answers) {
  const sideOf = (pick, skillAs) => {
    if (pick === 'tie') return 'tie';
    return pick === skillAs ? 'skill' : 'base';
  };
  const rows = key
    .map((k) => ({ ...k, person: answers.picks.find((p) => p.n === k.n)?.pick ?? null }))
    .filter((r) => r.person && r.judge?.pick)
    .map((r) => ({ person: sideOf(r.person, r.skillAs), judge: sideOf(r.judge.pick, r.skillAs) }));
  const n = rows.length;
  const tally = (who) => Object.fromEntries(['skill', 'base', 'tie'].map((c) => [c, rows.filter((r) => r[who] === c).length]));
  const person = tally('person');
  const judge = tally('judge');
  const same = rows.filter((r) => r.person === r.judge).length;
  const chance = n ? Object.keys(person).reduce((a, c) => a + (person[c] / n) * (judge[c] / n), 0) : 0;
  const observed = n ? same / n : null;
  const kappa = n && chance < 1 ? ((observed ?? 0) - chance) / (1 - chance) : null;
  return { pairs: n, same, observed, kappa, person, judge };
}
