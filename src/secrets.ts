import { createHash, timingSafeEqual } from 'node:crypto';

export const AUTHORIZATION_HEADER = 'authorization';

const BEARER_CREDENTIAL = /^bearer +(.*)$/i;

/**
 * Compares SHA-256 digests in constant time, so neither the content nor the length of the
 * expected value leaks through timing. An empty or missing side never matches, so an unset
 * secret authorizes nothing.
 */
export function secretsEqual({
  provided,
  expected,
}: {
  provided: string | null | undefined;
  expected: string | null | undefined;
}): boolean {
  if (!provided || !expected) {
    return false;
  }
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Whether `headers` carry `Authorization: Bearer <secret>`; false when the secret is unset. The
 * secret is trimmed, as a header value is, so one pasted with a trailing newline still matches.
 */
export function isBearerAuthorized({
  headers,
  secret,
}: {
  headers: Headers;
  secret: string | undefined;
}): boolean {
  const [, provided] = BEARER_CREDENTIAL.exec(headers.get(AUTHORIZATION_HEADER) ?? '') ?? [];
  return secretsEqual({ provided, expected: secret?.trim() });
}

/**
 * Null when the request carries the cron secret as a bearer token, the refusal to answer with
 * when not. An unset secret is a 503, so a deployment missing it shows up as a failing job
 * instead of a quiet stream of 401s.
 */
export function requireCronSecret({
  request,
  secret,
}: {
  request: Request;
  secret: string | undefined;
}): Response | null {
  const isSecretSet = Boolean(secret?.trim());
  if (!isSecretSet) {
    return Response.json({ error: 'This job is not configured.' }, { status: 503 });
  }
  const isAuthorized = isBearerAuthorized({ headers: request.headers, secret });
  return isAuthorized ? null : Response.json({ error: 'Unauthorized' }, { status: 401 });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
