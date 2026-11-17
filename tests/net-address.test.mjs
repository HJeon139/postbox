// Which addresses net.fetch never reaches (server/net-address.mjs): this computer, the local network and anything else
// not on the public internet, with an IPv4 address inside IPv6 classified by the address it carries.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateAddress } from '../server/net-address.mjs';

test('private, loopback, link-local and other non-public addresses are recognized', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.3.20',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:192.168.1.1',
    '::ffff:127.0.0.1',
    '172.16.0.0',
    '172.31.255.255',
    '198.18.0.1',
    '198.19.255.255',
    'fc00::1',
    'ff02::1',
    'febf::1',
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '198.17.255.255', '198.20.0.0', '2606:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(privateAddress(ip), false, ip);
});

test('an IPv4 address inside IPv6 is classified by the IPv4 address it carries, however it’s spelled', () => {
  for (const ip of [
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '::ffff:0:7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2001::1',
    '100::1',
    'fec0::1',
  ])
    assert.equal(privateAddress(ip), true, ip);
});
