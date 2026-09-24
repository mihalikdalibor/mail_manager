import { describe, it, expect } from 'vitest';
import { eventAddress, normalizeIp } from '../../src/core/security/ip.js';

describe('normalizeIp', () => {
  it("'local' stays 'local'", () => {
    expect(normalizeIp('local')).toBe('local');
  });

  it.each(['1.2.3.4', '203.0.113.7', '0.0.0.0', '255.255.255.255', '10.0.0.1'])(
    'IPv4 %s is unchanged',
    (ip) => {
      expect(normalizeIp(ip)).toBe(ip);
    },
  );

  it.each([
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::Ffff:10.0.0.1', '10.0.0.1'],
  ])('IPv4-mapped IPv6 %s → %s', (ip, expected) => {
    expect(normalizeIp(ip)).toBe(expected);
  });

  it.each([
    ['2001:0DB8:0001:0002:aaaa::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    ['fe80::1', 'fe80:0:0:0::/64'],
    ['2a00:1450:4001:0810:0000:0000:0000:200e', '2a00:1450:4001:810::/64'],
  ])('IPv6 %s → its /64 prefix %s', (ip, expected) => {
    expect(normalizeIp(ip)).toBe(expected);
  });

  it('two addresses in the same /64 share the key; another /64 does not', () => {
    expect(normalizeIp('2001:db8:1:2::1')).toBe(normalizeIp('2001:db8:1:2:dead:beef::9'));
    expect(normalizeIp('2001:db8:1:2::1')).not.toBe(normalizeIp('2001:db8:1:3::1'));
  });

  it.each([
    '',
    ' ',
    'garbage',
    '1.2.3.4\n',
    ' 1.2.3.4',
    'a"b',
    '999.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.4/24',
    'localhost',
    'LOCAL',
    '2001:db8::1::2',
    '2001:db8:::1',
    'gggg::1',
    '::ffff:999.1.1.1',
    '<HOST>',
    'mm-security {"kind":"permanent"}',
  ])('%j → invalid', (ip) => {
    expect(normalizeIp(ip)).toBe('invalid');
  });
});

describe('normalizeIp: IPv4 inside IPv6 and eventAddress', () => {
  it.each([
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['0:0:0:0:0:ffff:1.2.3.4', '1.2.3.4'],
    ['::ffff:0102:0304', '1.2.3.4'],
    ['::FFFF:102:304', '1.2.3.4'],
    ['::1.2.3.4', '1.2.3.4'],
    ['64:ff9b::1.2.3.4', '1.2.3.4'],
    ['64:ff9b::0102:0304', '1.2.3.4'],
  ])('%s → the embedded IPv4 %s (not a shared ::/64 bucket)', (ip, v4) => {
    expect(normalizeIp(ip)).toBe(v4);
    expect(eventAddress(ip)).toBe(v4);
  });

  it('different IPv4 clients in mapped/NAT64 form get different buckets', () => {
    expect(normalizeIp('::ffff:0102:0304')).not.toBe(normalizeIp('::ffff:0506:0708'));
    expect(normalizeIp('64:ff9b::1.2.3.4')).not.toBe(normalizeIp('64:ff9b::5.6.7.8'));
  });

  it('a zone id is ignored', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(eventAddress('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:1');
  });

  it('eventAddress: one concrete address for a firewall, null when there is none', () => {
    expect(eventAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(eventAddress('2001:DB8:1:2::1')).toBe('2001:db8:1:2:0:0:0:1');
    expect(eventAddress('local')).toBeNull();
    expect(eventAddress('garbage')).toBeNull();
    expect(eventAddress('1.2.3.4\n')).toBeNull();
  });
});
