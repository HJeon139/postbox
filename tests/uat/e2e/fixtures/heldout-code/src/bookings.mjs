import { existsSync, readFileSync } from 'node:fs';
import { REMIND_BEFORE_MS } from './config.mjs';
import { enqueue } from './jobs.mjs';

export function readBookings() {
  return existsSync('data/bookings.json') ? JSON.parse(readFileSync('data/bookings.json', 'utf8')) : [];
}

/** One reminder job per booking, due a day before it; a booking that already has one is left alone. */
export function scheduleReminders() {
  let added = 0;
  for (const b of readBookings()) {
    const job = { id: `reminder:${b.id}`, type: 'send-reminder', bookingId: b.id, runAt: Date.parse(b.at) - REMIND_BEFORE_MS };
    if (enqueue(job)) added += 1;
  }
  return added;
}
