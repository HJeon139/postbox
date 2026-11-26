// The fake clock the tests of the UAT runner’s waits run on (tools/uat/turns.mjs): node:test’s mock timers stand in for
// the clock, so a wait of minutes takes no real time.

/** Runs `work` while the fake clock moves on a quarter second at a time, until it settles or 20 fake minutes pass. */
export async function onFakeClock(t, work) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let out = null;
  const p = work().then(
    (value) => (out = { value }),
    (error) => (out = { error }),
  );
  try {
    for (let ms = 0; !out && ms < 20 * 60_000; ms += 250) {
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      if (!out) t.mock.timers.tick(250);
    }
    await p;
  } finally {
    t.mock.timers.reset();
  }
  if (out?.error) throw out.error;
  return out?.value;
}
