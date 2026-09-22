import { describe, it, expect } from 'vitest';
import { geoIpNotice } from '../../src/core/providers/geoip.js';

describe('geoIpNotice (shown when a connection fails)', () => {
  it('this-computer: says the connection failed, names GeoIP, the local country and both remedies', () => {
    const msg = geoIpNotice({ kind: 'this-computer' });
    expect(msg.toLowerCase()).toContain('not successful');
    // Credentials are checked first, before GeoIP.
    expect(msg.toLowerCase()).toMatch(/password/);
    expect(msg.toLowerCase().indexOf('password')).toBeLessThan(msg.indexOf('GeoIP'));
    expect(msg).toContain('GeoIP');
    expect(msg.toLowerCase()).toContain('this computer');
    expect(msg.toLowerCase()).toMatch(/allow/);
    expect(msg.toLowerCase()).toMatch(/turn geoip off/);
    expect(msg).toContain('Mail Manager');
  });

  it('server with a region names that region instead of this computer', () => {
    const msg = geoIpNotice({ kind: 'server', region: 'Germany' });
    expect(msg).toContain('Germany');
    expect(msg.toLowerCase()).toContain('server');
    expect(msg.toLowerCase()).not.toContain('this computer');
  });

  it('server without a region (hosting not decided yet) still reads correctly', () => {
    const msg = geoIpNotice({ kind: 'server' });
    expect(msg).toContain('the country where the Mail Manager server is hosted');
    expect(msg).not.toContain('()');
    expect(msg).not.toContain('undefined');
  });
});
