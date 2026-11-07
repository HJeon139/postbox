import { readBookings } from '../bookings.mjs';
import { log } from '../log.mjs';
import { sendText } from '../sms.mjs';

/** Texts the customer about tomorrow’s booking, unless it was canceled or has already started. */
export async function sendReminder(job, worker, now) {
  const booking = readBookings().find((b) => b.id === job.bookingId);
  if (!booking || booking.canceled) return log(`worker=${worker} skip job=${job.id} canceled`);
  if (Date.parse(booking.at) <= now) return log(`worker=${worker} skip job=${job.id} too late`);
  const when = new Date(booking.at).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  const started = Date.now();
  log(`worker=${worker} send-start job=${job.id}`);
  await sendText(booking.phone, `Hi ${booking.owner}, ${booking.pet} is booked in at Tidy Tails on ${when}. Reply C to cancel.`);
  log(`worker=${worker} sent job=${job.id} ms=${Date.now() - started}`);
}
