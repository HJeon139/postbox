// Writes the code fixture’s data (tests/uat/e2e/fixtures/heldout-code/data/bookings.json and logs/worker.log) from a
// fixed seed, then prints every fact the brief (code.md) states, computed from what it wrote. The log is a simulation
// of the fixture’s own code, with its constants: two workers, a 2 s poll, a 60 s lease, a 15 s sweep and a 30 s
// first retry. Run: node designs/skills/visual-explainer/briefs/heldout/make-code-log.mjs

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
const rand = mulberry32(4419);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);

const OWNERS = ['Mara', 'Teodor', 'Priya', 'Hollis', 'Wren', 'Anouk', 'Dario', 'Junie', 'Callum', 'Ines', 'Bram', 'Odette', 'Kofi', 'Liesl', 'Ravi', 'Saoirse'];
const PETS = ['Biscuit', 'Pepper', 'Moss', 'Tofu', 'Juniper', 'Rolo', 'Fig', 'Clementine', 'Waffles', 'Basil', 'Nori', 'Pickle', 'Ziggy', 'Marlow'];

function bookingsFor(firstDay, days, startId) {
  const list = [];
  let id = startId;
  for (let d = 0; d < days; d += 1) {
    const day = firstDay + d * 86_400_000;
    for (let slot = 0; slot < 18; slot += 1) {
      if (rand() < 0.45) continue; // half-hour slots from 8:00 to 16:30, a bit over half of them booked
      const at = day + 8 * 3_600_000 + slot * 1_800_000;
      list.push({
        id: `b${id}`,
        at: new Date(at).toISOString(),
        owner: pick(OWNERS),
        pet: pick(PETS),
        phone: `+131255501${String(Math.floor(rand() * 100)).padStart(2, '0')}`,
        canceled: rand() < 0.06,
      });
      id += 1;
    }
  }
  return list;
}

// Last week’s bookings (Tuesday 27 October to Sunday 1 November 2026) drive the log; next week’s go in bookings.json.
const lastWeek = bookingsFor(Date.UTC(2026, 9, 27), 6, 3100);
const nextWeek = bookingsFor(Date.UTC(2026, 10, 10), 6, 3100 + lastWeek.length);

// The simulation, in 100 ms ticks, of src/worker.mjs, src/jobs.mjs and src/sweeper.mjs.
const LEASE = 60_000;
const SWEEP = 15_000;
const POLL = 2_000;
const BASE = 30_000;
const MAX_ATTEMPTS = 5;
const start = Date.UTC(2026, 9, 26, 6, 0, 0);
const end = Date.UTC(2026, 9, 31, 18, 0, 0);
const jobs = lastWeek.map((b) => ({ id: `reminder:${b.id}`, booking: b, runAt: Date.parse(b.at) - 86_400_000, state: 'queued', attempts: 0, leaseUntil: 0 }));
const workers = [1, 2].map((n) => ({ n, busyUntil: 0, nextPoll: start, job: null, outcome: null, sendStarted: 0 }));
const lines = [];
const sends = []; // { job, worker, started, ms, ok }
const log = (t, line) => lines.push(`${new Date(t).toISOString()} ${line}`);
log(start, `start workers=2 scheduled=${jobs.length}`);

function claim(w, t) {
  const job = jobs.find((j) => j.state === 'queued' && j.runAt <= t);
  if (!job) return false;
  Object.assign(job, { state: 'running', leaseUntil: t + LEASE, attempts: job.attempts + 1 });
  log(t, `worker=${w.n} claim job=${job.id} attempt=${job.attempts}`);
  if (job.booking.canceled) {
    log(t + 3, `worker=${w.n} skip job=${job.id} canceled`);
    job.state = 'done';
    log(t + 4, `worker=${w.n} complete job=${job.id}`);
    w.nextPoll = t + 5;
    return true;
  }
  const slow = rand() < 0.12;
  const ms = Math.round(slow ? between(45_000, 88_000) : between(350, 2_800));
  const ok = rand() > 0.03;
  log(t + 4, `worker=${w.n} send-start job=${job.id}`);
  Object.assign(w, { job, busyUntil: t + 4 + ms, sendStarted: t + 4, outcome: { ok, ms } });
  return true;
}

function finish(w) {
  const t = w.busyUntil;
  const { job, outcome } = w;
  sends.push({ job: job.id, worker: w.n, started: w.sendStarted, ms: outcome.ms, ok: outcome.ok });
  if (outcome.ok) {
    log(t, `worker=${w.n} sent job=${job.id} ms=${outcome.ms}`);
    Object.assign(job, { state: 'done', leaseUntil: 0 });
    log(t + 2, `worker=${w.n} complete job=${job.id}`);
  } else {
    const dead = job.attempts >= MAX_ATTEMPTS;
    Object.assign(job, dead ? { state: 'dead' } : { state: 'queued', runAt: t + Math.round(BASE * 2 ** (job.attempts - 1) * (1 + rand() / 5)) });
    job.leaseUntil = 0;
    log(t + 2, `worker=${w.n} fail job=${job.id} attempt=${job.attempts} ${dead ? 'dead' : 'retry'}: The text provider answered 503.`);
  }
  Object.assign(w, { job: null, outcome: null, nextPoll: t + 3 });
}

for (let t = start; t <= end; t += 100) {
  for (const w of workers) if (w.job && w.busyUntil <= t) finish(w);
  if ((t - start) % SWEEP === 0 && t > start) {
    for (const job of jobs.filter((j) => j.state === 'running' && j.leaseUntil < t)) {
      Object.assign(job, { state: 'queued', leaseUntil: 0, runAt: t });
      log(t + 1, `sweeper requeue job=${job.id} lease expired`);
    }
  }
  for (const w of workers) {
    if (w.job || w.nextPoll > t) continue;
    if (!claim(w, t)) w.nextPoll = t + POLL;
  }
}

const fixture = join(import.meta.dirname, '..', '..', '..', '..', '..', 'tests', 'uat', 'e2e', 'fixtures', 'heldout-code');
mkdirSync(join(fixture, 'data'), { recursive: true });
mkdirSync(join(fixture, 'logs'), { recursive: true });
writeFileSync(join(fixture, 'data', 'bookings.json'), `${JSON.stringify(nextWeek, null, 2)}\n`);
lines.sort();
writeFileSync(join(fixture, 'logs', 'worker.log'), `${lines.join('\n')}\n`);

// The facts, from the simulated sends.
const delivered = sends.filter((s) => s.ok);
const byJob = Map.groupBy([...delivered].sort((a, b) => a.started - b.started), (s) => s.job);
const doubled = [...byJob].filter(([, list]) => list.length > 1);
const slow = sends.filter((s) => s.ms > LEASE);
const slowFirstOfDouble = doubled.filter(([, list]) => list[0].ms > LEASE).length;
const slowNoDouble = slow.filter((s) => byJob.get(s.job)?.length === 1).length;
const failed = sends.filter((s) => !s.ok);
const requeues = lines.filter((l) => l.includes('sweeper requeue')).length;
console.log(`bookings last week ${lastWeek.length}, canceled ${lastWeek.filter((b) => b.canceled).length}; next week ${nextWeek.length}`);
console.log(`texts sent ${delivered.length} to ${byJob.size} bookings; bookings texted twice ${doubled.length}`);
console.log(`sends over 60 s: ${slow.length}; doubles whose first send took over 60 s: ${slowFirstOfDouble}; slow sends with no double: ${slowNoDouble}`);
console.log(`sweeper requeues ${requeues}; failed sends ${failed.length}, retried ${lines.filter((l) => l.includes(' retry:')).length}, dead ${lines.filter((l) => l.includes(' dead:')).length}`);
const fastest = Math.min(...doubled.map(([, list]) => list[0].ms));
const slowestSingle = Math.max(...slow.filter((s) => byJob.get(s.job)?.length === 1).map((s) => s.ms), 0);
console.log(`shortest first send among doubles ${fastest} ms; longest slow send that didn’t double ${slowestSingle} ms`);
const doubledAfterRetry = doubled.filter(([id]) => failed.some((f) => f.job === id)).length;
console.log(`doubles that involved a failed send: ${doubledAfterRetry}; log lines ${lines.length}`);
