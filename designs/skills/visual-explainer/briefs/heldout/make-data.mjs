// Writes tests/uat/e2e/fixtures/heldout-data/dishes.csv from a fixed seed, then prints every fact the brief
// (data.md) states, computed from the rows it wrote. Run: node designs/skills/visual-explainer/briefs/heldout/make-data.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261106);
const between = (lo, hi) => lo + rand() * (hi - lo);

// Each course: its dishes from cheapest to priciest, its price range, and the orders a dish at the course's middle price gets in a quarter.
const COURSES = [
  { course: 'side', names: ['Herb rice', 'Hand-cut fries', 'Garlic bread', 'Pickled slaw', 'Side salad', 'Buttered corn', 'Roast carrots', 'Charred greens'], lo: 4, hi: 8, base: 150 },
  { course: 'dessert', names: ['Affogato', 'Ginger cake', 'Lemon posset', 'Plum crumble', 'Chocolate pot', 'Burnt honey tart'], lo: 7, hi: 11, base: 230 },
  { course: 'starter', names: ['Leek soup', 'Chicken livers', 'Fried halloumi', 'Beet carpaccio', 'Lamb skewers', 'Crispy squid', 'Smoked trout toast', 'Burrata plate'], lo: 9, hi: 15, base: 330 },
  {
    course: 'main',
    names: ['Gnocchi', 'Mushroom risotto', 'Fish pie', 'Juniper roast chicken', 'Pork chop', 'Hake and clams', 'Duck leg', 'Market fish', 'Lamb shoulder', 'Flank steak', 'Short rib', 'Ribeye'],
    lo: 17,
    hi: 32,
    base: 520,
  },
];
const DROP_PER_TENTH = 0.12; // orders fall by this share for each tenth of the course's middle price added

const rows = [];
for (const c of COURSES) {
  const mid = (c.lo + c.hi) / 2;
  const prices = c.names.map(() => Math.round(between(c.lo, c.hi) * 2) / 2).sort((a, b) => a - b); // to the half dollar
  for (const [i, name] of c.names.entries()) {
    const price = prices[i];
    const expected = c.base * (1 - DROP_PER_TENTH * ((price - mid) / (mid / 10)));
    const orders = Math.max(5, Math.round(expected * between(0.8, 1.2)));
    rows.push({ dish: name, course: c.course, price, orders });
  }
}

const out = join(import.meta.dirname, '..', '..', '..', '..', '..', 'tests', 'uat', 'e2e', 'fixtures', 'heldout-data');
mkdirSync(out, { recursive: true });
const csv = ['dish,course,price,orders_last_13_weeks', ...rows.map((r) => `${r.dish},${r.course},${r.price.toFixed(2)},${r.orders}`)].join('\n');
writeFileSync(join(out, 'dishes.csv'), `${csv}\n`);

// The facts, from the rows.
function fit(list) {
  const n = list.length;
  const mx = list.reduce((s, r) => s + r.price, 0) / n;
  const my = list.reduce((s, r) => s + r.orders, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const r of list) {
    sxy += (r.price - mx) * (r.orders - my);
    sxx += (r.price - mx) ** 2;
    syy += (r.orders - my) ** 2;
  }
  return { n, meanPrice: mx, meanOrders: my, slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy) };
}
const show = (label, f) =>
  console.log(
    `${label}: n=${f.n} mean price $${f.meanPrice.toFixed(2)} mean orders ${f.meanOrders.toFixed(0)} slope ${f.slope.toFixed(1)} orders per $1 (${((100 * f.slope) / f.meanOrders).toFixed(1)}% of the mean) r=${f.r.toFixed(2)}`,
  );
show('all', fit(rows));
for (const c of COURSES) {
  const list = rows.filter((r) => r.course === c.course);
  show(c.course, fit(list));
  const byPrice = [...list].sort((a, b) => a.price - b.price);
  const lo = byPrice[0];
  const hi = byPrice[byPrice.length - 1];
  console.log(`  cheapest ${lo.dish} $${lo.price} ${lo.orders}; priciest ${hi.dish} $${hi.price} ${hi.orders}; price range $${lo.price}-$${hi.price}`);
}
const ranked = [...rows].sort((a, b) => b.orders - a.orders);
console.log('top 5 by orders:', ranked.slice(0, 5).map((r) => `${r.dish} (${r.course}, $${r.price}, ${r.orders})`).join('; '));
console.log('bottom 5 by orders:', ranked.slice(-5).map((r) => `${r.dish} (${r.course}, $${r.price}, ${r.orders})`).join('; '));
const byPrice = [...rows].sort((a, b) => b.price - a.price);
console.log('5 priciest:', byPrice.slice(0, 5).map((r) => `${r.dish} $${r.price} ${r.orders}`).join('; '));
const total = rows.reduce((s, r) => s + r.orders, 0);
const mains = rows.filter((r) => r.course === 'main').reduce((s, r) => s + r.orders, 0);
console.log(`total orders ${total}; mains ${mains}`);
const mainFit = fit(rows.filter((r) => r.course === 'main'));
const mainRows = rows.filter((r) => r.course === 'main');
const lost = -2 * mainFit.slope * mainFit.n;
const revenue = mainRows.reduce((s, r) => s + r.price * r.orders, 0);
const after = mainRows.reduce((s, r) => s + (r.price + 2) * (r.orders + 2 * mainFit.slope), 0);
console.log(`mains +$2 each: about ${lost.toFixed(0)} fewer main orders a quarter (${((100 * lost) / mains).toFixed(1)}%)`);
console.log(`main revenue now $${revenue.toFixed(0)}, after +$2 on the mains' own slope $${after.toFixed(0)} (${((100 * (after - revenue)) / revenue).toFixed(1)}%)`);
