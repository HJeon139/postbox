// The numbers behind the brief with no files (idea.md): a one-lane ring road in the Nagel–Schreckenberg cell model
// (7.5 m cells, one-second steps, a top speed of 4 cells a second, 108 km/h), from a fixed seed. Each second every
// driver speeds up by one if there’s room, slows to the gap ahead, and with chance P eases off by one for no reason.
// Prints every fact the brief states. Run: node designs/skills/visual-explainer/briefs/heldout/simulate-idea.mjs

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELLS = 400; // 3 km of road
const CELL_M = 7.5;
const VMAX = 4;
const KMH = (cellsPerSecond) => cellsPerSecond * CELL_M * 3.6;

function run({ cars, p, seconds, seed }) {
  const rand = mulberry32(seed);
  const pos = Array.from({ length: cars }, (_, i) => Math.floor((i * CELLS) / cars));
  const vel = Array(cars).fill(Math.min(VMAX, Math.floor(CELLS / cars) - 1));
  const history = []; // per second: the cells of stopped cars
  let firstStop = null;
  let moved = 0;
  const stoppedSeconds = Array(cars).fill(0);
  for (let t = 0; t < seconds; t += 1) {
    const order = pos.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const next = new Map(order.map(([, i], k) => [i, order[(k + 1) % cars][1]]));
    const nv = vel.map((v, i) => {
      const gap = (pos[next.get(i)] - pos[i] - 1 + CELLS) % CELLS;
      let s = Math.min(v + 1, VMAX, gap);
      if (s > 0 && rand() < p) s -= 1;
      return s;
    });
    for (let i = 0; i < cars; i += 1) {
      vel[i] = nv[i];
      pos[i] = (pos[i] + vel[i]) % CELLS;
      moved += vel[i];
      if (vel[i] === 0) stoppedSeconds[i] += 1;
    }
    const stopped = pos.filter((_, i) => vel[i] === 0);
    if (stopped.length && firstStop === null) firstStop = t + 1;
    history.push(stopped);
  }
  return { history, firstStop, meanSpeed: moved / (cars * seconds), stoppedSeconds };
}

// How fast the jam drifts: follow the rear of the largest group of stopped cars, second by second.
function jamDrift(history, from, to) {
  const rearOf = (stopped) => {
    if (stopped.length < 3) return null;
    const s = [...stopped].sort((a, b) => a - b);
    let best = { size: 0, rear: null };
    let start = 0;
    for (let k = 1; k <= s.length; k += 1) {
      if (k === s.length || s[k] - s[k - 1] > 3) {
        if (k - start > best.size) best = { size: k - start, rear: s[start] };
        start = k;
      }
    }
    return best.rear;
  };
  const steps = [];
  let prev = rearOf(history[from]);
  for (let t = from + 1; t < to; t += 1) {
    const r = rearOf(history[t]);
    if (prev !== null && r !== null) {
      const d = ((r - prev + CELLS / 2 + CELLS) % CELLS) - CELLS / 2;
      if (Math.abs(d) <= 3) steps.push(d);
    }
    prev = r;
  }
  return steps.reduce((a, b) => a + b, 0) / steps.length;
}

const SECONDS = 1800;
for (const cars of [30, 45, 60, 75, 90, 120]) {
  const calm = run({ cars, p: 0, seconds: SECONDS, seed: 1 });
  const real = run({ cars, p: 0.2, seconds: SECONDS, seed: 20261106 });
  const late = real.history.slice(600);
  const share = late.reduce((s, h) => s + h.length, 0) / (late.length * cars);
  const stoppedPerCar = real.stoppedSeconds.reduce((a, b) => a + b, 0) / cars;
  const perKm = cars / ((CELLS * CELL_M) / 1000);
  console.log(
    `${cars} cars (${perKm.toFixed(0)} a km): without hesitation ${calm.firstStop === null ? 'no car ever stops' : `a stop at ${calm.firstStop} s`}, ${KMH(calm.meanSpeed).toFixed(0)} km/h; ` +
      `with p=0.2 first stop at ${real.firstStop ?? 'never'} s, mean speed ${KMH(real.meanSpeed).toFixed(0)} km/h, flow ${(perKm * KMH(real.meanSpeed)).toFixed(0)} cars an hour past a point, ${(100 * share).toFixed(1)}% of cars stopped at a time after 10 min, ` +
      `each car stopped ${(stoppedPerCar / 60).toFixed(1)} min in 30 min`,
  );
  if (real.firstStop !== null && share > 0.02) {
    const drift = jamDrift(real.history, 600, SECONDS);
    console.log(`  the jam’s rear moves ${drift.toFixed(2)} cells a second, ${KMH(drift).toFixed(1)} km/h (negative is backward)`);
  }
}
