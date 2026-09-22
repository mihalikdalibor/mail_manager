/**
 * Who opens the IMAP connection: the CLI on the user's computer, or the server app.
 * `region` is optional because the hosting (Vercel / VPS) isn't decided yet.
 */
export type ConnectingFrom = { kind: 'this-computer' } | { kind: 'server'; region?: string };

/**
 * Hint shown when an IMAP connection fails (from M1b-2 on — not with discovery results).
 * Credentials come first; then GeoIP: some mail hosts block logins by country, which makes
 * a correct host and password look like a network failure.
 * The server variant needs the hosting country: set it where the server is deployed
 * (see CLAUDE.md), otherwise the text falls back to "where the server is hosted".
 */
export function geoIpNotice(from: ConnectingFrom): string {
  const location =
    from.kind === 'this-computer'
      ? "the country you are connecting from (this computer's public IP address)"
      : from.region === undefined
        ? 'the country where the Mail Manager server is hosted'
        : `the country where the Mail Manager server is hosted (${from.region})`;
  return (
    'The connection was not successful. First check that the email address, password and ' +
    'IMAP server are correct. If they are, check whether GeoIP (country) security is turned ' +
    `on for this mailbox at your mail host. If it is, allow ${location}, or turn GeoIP off ` +
    'while Mail Manager connects.'
  );
}
