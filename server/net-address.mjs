// Which addresses net.fetch never reaches: this computer, the local network, and anything else not on the public
// internet (designs/architecture/security-boundaries.md, “What leaves through net.fetch”). Every address is classified
// by node’s BlockList, which also matches an IPv4 address carried inside IPv6 (::ffff:7f00:1 is 127.0.0.1), however
// it’s spelled. The ranges that carry IPv4 inside IPv6 another way (NAT64, 6to4, Teredo, IPv4-compatible) are refused
// whole, since what they reach depends on a gateway this computer can’t see.

import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/** @type {[string, number][]} */
const V4 = [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 3], // multicast, reserved and broadcast: 224.0.0.0 and up
];

/** @type {[string, number][]} */
const V6 = [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
];

const blocked = new BlockList();
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/**
 * Whether an IP address is this computer’s, the local network’s, or otherwise not on the public internet. IPv4-mapped
 * IPv6 (::ffff:a.b.c.d, in either spelling) is checked as the IPv4 address it carries. @param {string} ip
 */
export function privateAddress(ip) {
  const family = isIP(ip);
  if (family === 0) return true; // not an address at all: never treat it as public
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * A DNS lookup that refuses a private address, so a name that resolves to one is refused in the lookup the socket
 * connects with, and a second lookup can’t swap one in (DNS rebinding). It answers in the shape asked for: node asks
 * for every address when it races IPv4 and IPv6, and then any private one refuses the name.
 * @param {boolean} anyAddress  the host is on the allow list
 */
export const guardedLookup = (anyAddress) => (host, opts, cb) =>
  lookup(host, { ...opts, all: true }, (err, answer) => {
    if (err) return cb(err);
    const addresses = /** @type {import('node:dns').LookupAddress[]} */ (/** @type {unknown} */ (answer));
    const bad = anyAddress ? undefined : addresses.find((a) => privateAddress(a.address));
    if (bad) return cb(Object.assign(new Error(`${host} is a private address (${bad.address}).`), { code: 'EPRIVATE' }));
    if (opts?.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
