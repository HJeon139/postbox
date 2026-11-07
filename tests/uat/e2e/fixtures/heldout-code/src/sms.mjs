import { appendFileSync, mkdirSync } from 'node:fs';
import { SEND_TIMEOUT_MS } from './config.mjs';

/** Sends one text through the provider, or to data/outbox.log when no provider is set. */
export async function sendText(to, body) {
  const url = process.env.SMS_URL;
  if (!url) {
    mkdirSync('data', { recursive: true });
    appendFileSync('data/outbox.log', `${new Date().toISOString()} ${to} ${body}\n`);
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, body }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The text provider answered ${res.status}.`);
}
