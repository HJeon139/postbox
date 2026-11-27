// Why a hosted Postbox refused a sign-in, for whoever runs it (designs/architecture/hosted.md, “What a refused request
// gets”). A person is told only “sign in”; the server’s log says which part of the check failed, so a deployment whose
// settings don’t match its load balancer can be told from one nobody has signed in to. The port is open to whatever
// the network lets reach it, so a line is written at most once a minute for each reason, with how many it stands for.
// It writes the reason’s name and nothing of the request: no token, no claim, no address.

const MINUTE_MS = 60_000;

/**
 * @param {{ now?: () => number, log?: (line: string) => void }} [io]
 * @returns {(e: any) => void}  given what the provider threw
 */
export function refusalLog({ now = Date.now, log = (line) => console.log(line) } = {}) {
  /** @type {Map<string, { at: number, more: number }>} */
  const said = new Map();
  return (e) => {
    // A 401’s reason is a name from the token’s check; a 403’s code is one of the provider’s own. Neither is the request’s text.
    const reason = String(e?.reason ?? e?.code ?? 'error');
    const last = said.get(reason);
    if (last && now() - last.at < MINUTE_MS) {
      last.more++;
      return;
    }
    log(`Postbox refused a sign-in: ${reason}${last?.more ? `, and ${last.more} more like it since it last said so` : ''}.`);
    said.set(reason, { at: now(), more: 0 });
  };
}
