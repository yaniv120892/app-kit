export const FORWARDED_FOR_HEADER = 'x-forwarded-for';

const UNKNOWN_CLIENT = 'unknown';

/**
 * The first `x-forwarded-for` entry, which is the client only because the deployment's edge proxy
 * overwrites the header with the address it accepted the connection from. Behind a proxy that
 * appends instead, the first entry is client-supplied and a limit keyed on it is spoofable.
 */
export function readClientAddress(headers: Headers): string {
  const forwardedFor = headers.get(FORWARDED_FOR_HEADER);
  const firstHop = forwardedFor?.split(',')[0]?.trim();
  return firstHop || UNKNOWN_CLIENT;
}

/** The rate-limit client id for a request's address. */
export function addressClient(headers: Headers): string {
  return `ip:${readClientAddress(headers)}`;
}
