// The front door of a hosted Postbox (#558, prototype): which addresses it answers as, once it runs in a cluster
// behind a load balancer that terminates TLS and signs people in, instead of on one person’s computer.
//
//   POSTBOX_PUBLIC_ORIGIN  the https address people open, such as https://postbox.example.com. Requests addressed to it
//                          pass the Host and Origin checks, and the page’s cookie is marked Secure.
//   POSTBOX_LISTEN         the address to bind, such as 0.0.0.0 in a pod, so the balancer can reach it.
//
// Neither is taken without sign-in: listening beyond this computer with the local identity would make everyone who can
// reach the port the unix user Postbox runs as.

/**
 * @param {NodeJS.ProcessEnv} env @param {number} port @param {'local' | 'alb'} mode
 * @returns {{ hosts: string[], origins: string[], listen?: string, secure: boolean }}
 */
export function frontDoor(env, port, mode) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origins = hosts.map((h) => `http://${h}`);
  const { POSTBOX_PUBLIC_ORIGIN: open, POSTBOX_LISTEN: listen } = env;
  if (!open && !listen) return { hosts, origins, secure: false };
  if (mode === 'local')
    throw new Error('POSTBOX_PUBLIC_ORIGIN and POSTBOX_LISTEN serve Postbox beyond this computer, which needs sign-in. Set POSTBOX_IDENTITY=alb with them.');
  if (!open) throw new Error('POSTBOX_LISTEN needs POSTBOX_PUBLIC_ORIGIN, the https address people open, so Postbox knows which requests are its own.');
  const url = new URL(open);
  if (url.protocol !== 'https:' || url.pathname !== '/')
    throw new Error(`POSTBOX_PUBLIC_ORIGIN is an https origin with no path, such as https://postbox.example.com, not “${open}”.`);
  return { hosts: [...hosts, url.host], origins: [...origins, url.origin], ...(listen ? { listen } : {}), secure: true };
}
