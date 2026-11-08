// Calibrating the side-by-side judge (#995) before its rate counts against #206’s bar. The maintainer judges pairs
// blind on a page: the person, their first message, and the two answers in an order of the page’s own, with neither
// side named. The page saves their picks as JSON; agreement() compares them with the judge’s.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml, renderMarkdown } from '../../shared/markdown.mjs';
import { firstExchange } from './picture-choice.mjs';

/**
 * One pair as the page shows it, from a run whose run.json holds sideBySide.
 * @param {string} dir  the run’s folder @param {any} record  its run.json @param {string} persona
 */
export function pairOf(dir, record, persona) {
  const x = firstExchange(join(dir, 'data'));
  return {
    run: record.run,
    persona,
    question: x?.question ?? record.sideBySide.question,
    reply: x?.reply ?? '',
    shot: join(dir, record.sideBySide.picture.shot),
    words: readFileSync(join(dir, record.sideBySide.words), 'utf8'),
    judge: record.sideBySide.pick,
  };
}

const answerHtml = (side, body) => `<section class="answer"><h3>Answer ${side}</h3>${body}</section>`;

/** One pair’s card, with the picture as A or B. @param {any} p @param {number} n @param {boolean} pictureA */
function card(p, n, pictureA) {
  const picture = `${renderMarkdown(p.reply)}<img src="${n}-picture.png" alt="The picture in this answer, as it was on screen">`;
  const words = renderMarkdown(p.words);
  const [a, b] = pictureA ? [picture, words] : [words, picture];
  const choice = ['A', 'B', 'tie']
    .map((v) => `<label><input type="radio" name="p${n}" value="${v}"> ${v === 'tie' ? 'Neither' : `Answer ${v}`}</label>`)
    .join('');
  return `<article class="pair" data-n="${n}">
<h2>Pair ${n}</h2>
<p class="who">${escapeHtml(p.persona)}</p>
<p class="ask">They asked: “${escapeHtml(p.question)}”</p>
<div class="answers">${answerHtml('A', a)}${answerHtml('B', b)}</div>
<fieldset><legend>As this person, which would you rather have got?</legend>${choice}
<input type="text" class="note" aria-label="Why, in a few words (optional)" placeholder="Why, in a few words (optional)"></fieldset>
</article>`;
}

const STYLE = `:root{--bg:#fbfaf7;--panel:#fff;--text:#1d1d1b;--dim:#5d5b55;--line:#dedbd2;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--panel:#252523;--text:#ecebe6;--dim:#a9a69c;--line:#3b3a36;--accent:#8fb0ff}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
.pair{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
.who,.dim{color:var(--dim)}.ask{font-weight:600}
.answers{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:800px){.answers{grid-template-columns:1fr}}
.answer{border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;max-height:80vh}
.answer img{max-width:100%;border:1px solid var(--line)}
.answer table{border-collapse:collapse}.answer td,.answer th{border:1px solid var(--line);padding:2px 6px}
fieldset{border:0;padding:8px 0 0;display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.note{flex:1;min-width:200px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px}
button{font:inherit;padding:8px 16px;background:var(--accent);color:#fff;border:0;border-radius:6px;cursor:pointer}
textarea{width:100%;height:120px;font:13px ui-monospace,monospace;background:var(--panel);color:var(--text);border:1px solid var(--line)}`;

// Saves the picks as picks.json, and shows them to copy; keeps them in this browser meanwhile, where it can.
const SCRIPT = `const pairs=[...document.querySelectorAll('.pair')];
const read=()=>({picks:pairs.map((a)=>({n:Number(a.dataset.n),pick:a.querySelector('input[type=radio]:checked')?.value??null,note:a.querySelector('.note').value}))});
const keep=()=>{try{localStorage.setItem('picks',JSON.stringify(read()))}catch{}};
try{const had=JSON.parse(localStorage.getItem('picks')??'null');for(const p of had?.picks??[]){const a=pairs.find((x)=>Number(x.dataset.n)===p.n);if(!a)continue;if(p.pick)a.querySelector('input[value="'+p.pick+'"]').checked=true;a.querySelector('.note').value=p.note??''}}catch{}
document.addEventListener('change',keep);document.addEventListener('input',keep);
document.getElementById('save').addEventListener('click',()=>{const json=JSON.stringify(read(),null,2);document.getElementById('out').value=json;
const left=read().picks.filter((p)=>!p.pick).length;document.getElementById('left').textContent=left?left+' pairs have no pick yet.':'Every pair has a pick.';
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([json],{type:'application/json'}));a.download='picks.json';a.click();});`;

/**
 * Writes the blind page into `out`: index.html and each pair’s picture. Returns the key, which stays out of the page’s
 * folder: which answer was the picture in each pair, and what the judge picked.
 * @param {ReturnType<typeof pairOf>[]} pairs @param {{ out: string, random?: () => number }} o
 */
export function calibrationPage(pairs, { out, random = Math.random }) {
  mkdirSync(out, { recursive: true });
  const key = pairs.map((p, i) => ({ n: i + 1, run: p.run, pictureAs: random() < 0.5 ? 'A' : 'B', judge: p.judge }));
  pairs.forEach((p, i) => {
    if (existsSync(p.shot)) copyFileSync(p.shot, join(out, `${i + 1}-picture.png`));
  });
  const cards = pairs.map((p, i) => card(p, i + 1, key[i].pictureAs === 'A')).join('\n');
  writeFileSync(
    join(out, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Picture or words</title><style>${STYLE}</style></head><body><main>
<h1>Picture or words: ${pairs.length} pairs</h1>
<p class="dim">Each pair is one person’s first message to an agent, answered twice. Read both answers as that person, and pick the one you’d rather have got, or Neither. Judge what each lets them understand or decide. The order of the answers is random.</p>
${cards}
<p><button id="save" type="button">Save my picks</button> <span id="left" class="dim"></span></p>
<p class="dim">This saves picks.json. Send it back, or paste what’s below.</p>
<textarea id="out" readonly aria-label="Your picks as JSON"></textarea>
</main><script>${SCRIPT}</script></body></html>
`,
  );
  return key;
}

const sideOf = (pick, pictureAs) => {
  if (pick === 'tie') return 'tie';
  return pick === pictureAs ? 'picture' : 'words';
};

/**
 * The judge’s agreement with the maintainer’s picks: how often they picked the same, and Cohen’s κ over picture, words
 * and tie, which discounts what two judges would agree on by chance. Pairs without a pick are left out.
 * @param {{ n: number, pictureAs: 'A'|'B', judge: string }[]} key @param {{ picks: { n: number, pick: string|null }[] }} answers
 */
export function agreement(key, answers) {
  const rows = key
    .map((k) => ({ ...k, person: answers.picks.find((p) => p.n === k.n)?.pick ?? null }))
    .filter((r) => r.person)
    .map((r) => ({ person: sideOf(r.person, r.pictureAs), judge: r.judge }));
  const n = rows.length;
  const tally = (who) => Object.fromEntries(['picture', 'words', 'tie'].map((c) => [c, rows.filter((r) => r[who] === c).length]));
  const person = tally('person');
  const judge = tally('judge');
  const same = rows.filter((r) => r.person === r.judge).length;
  const chance = n ? Object.keys(person).reduce((a, c) => a + (person[c] / n) * (judge[c] / n), 0) : 0;
  const observed = n ? same / n : null;
  const kappa = n && chance < 1 ? ((observed ?? 0) - chance) / (1 - chance) : null;
  return { pairs: n, same, observed, kappa, person, judge };
}
