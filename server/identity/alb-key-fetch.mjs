// How a hosted Postbox fetches a load balancer’s public key (designs/architecture/hosted.md, “The check, whole”). The
// address is built in server/identity/alb-keys.mjs from the deployment’s region and a key id already held to a key
// id’s shape; this only fetches it, and bounds what an answer can cost: how long it may take and how much it may send.
// It follows no redirect, since the endpoint serves the key itself, and sends nothing of the request it is for.

/** How long the endpoint has to answer. A request waits on this, so it is short. */
const TIMEOUT_MS = 3000;
/** The most an answer may be. A P-256 public key in PEM is under 200 bytes. */
const MOST_BYTES = 4096;

/**
 * A URL’s text, when it answers 200 in time with no more than a key’s worth; else it rejects, saying which.
 * @param {string} url @param {{ timeoutMs?: number, mostBytes?: number, ask?: typeof fetch }} [bounds]  ask: tests pass a fake
 * @returns {Promise<string>}
 */
export async function fetchKeyText(url, { timeoutMs = TIMEOUT_MS, mostBytes = MOST_BYTES, ask = fetch } = {}) {
  const answer = await ask(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/plain' } });
  if (answer.status !== 200 || !answer.body) {
    await answer.body?.cancel();
    throw new Error(`The key endpoint answered ${answer.status}, not a key.`);
  }
  const chunks = [];
  let size = 0;
  // Leaving the loop by a throw ends the read, so no more of a long answer is taken than the bound.
  for await (const chunk of answer.body) {
    size += chunk.length;
    if (size > mostBytes) throw new Error(`The key endpoint sent more than ${mostBytes} bytes, which is no key.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
