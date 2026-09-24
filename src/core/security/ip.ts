import { isIP } from 'node:net';

/** Expands a valid IPv6 address (zone id already removed) to its 8 hextets as numbers. */
function expandV6(ip: string): number[] {
  const [head = '', tail] = ip.split('::');
  // An embedded IPv4 part (e.g. ::ffff:1.2.3.4) takes two hextets.
  const convert = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((p) => {
          if (!p.includes('.')) return [parseInt(p, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = p.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const left = convert(head);
  const right = tail === undefined ? [] : convert(tail);
  const fill = tail === undefined ? [] : Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...fill, ...right];
}

function v4FromHextets(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

type Parsed = { v: 4; addr: string } | { v: 6; hextets: number[] };

/** IPv4, or IPv6 with every IPv4-in-IPv6 form (mapped, compatible, NAT64) turned into IPv4. */
function parse(ip: string): Parsed | null {
  if (isIP(ip) === 4) return { v: 4, addr: ip };
  const bare = ip.split('%')[0] ?? ''; // zone id (fe80::1%eth0) is local routing info
  if (isIP(bare) !== 6) return null;
  const h = expandV6(bare.toLowerCase());
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, last = 0] = h;
  const zeros5 = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  // ::ffff:a.b.c.d (any spelling) — IPv4-mapped.
  if (zeros5 && f === 0xffff) return { v: 4, addr: v4FromHextets(g, last) };
  // ::a.b.c.d — IPv4-compatible (deprecated), but not :: / ::1.
  if (zeros5 && f === 0 && g !== 0) return { v: 4, addr: v4FromHextets(g, last) };
  // 64:ff9b::a.b.c.d — NAT64 well-known prefix: the client is the embedded IPv4.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return { v: 4, addr: v4FromHextets(g, last) };
  }
  return { v: 6, hextets: h };
}

/**
 * Bucket for counting login attempts by IP. `local` (the CLI's own attempts — never accept it
 * from a request header) stays as is; IPv4 and every IPv4-in-IPv6 form become the IPv4
 * address; other IPv6 addresses count per /64 (one customer network), so rotating addresses
 * inside it doesn't escape an IP block. Anything else is `invalid` — so store keys and log
 * lines never carry injected text.
 */
export function normalizeIp(ip: string): string {
  if (ip === 'local') return ip;
  const p = parse(ip);
  if (p === null) return 'invalid';
  if (p.v === 4) return p.addr;
  return `${p.hextets
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/**
 * One concrete address for firewall bans (fail2ban `<ADDR>`): IPv4, or the full IPv6 address
 * without zone id. null for `local` and unparsable input (nothing a firewall could ban).
 */
export function eventAddress(ip: string): string | null {
  const p = parse(ip);
  if (p === null) return null;
  if (p.v === 4) return p.addr;
  return p.hextets.map((x) => x.toString(16)).join(':');
}
