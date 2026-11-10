import { describe, expect, it } from 'vitest';
import { isBearerAuthorized, requireCronSecret, secretsEqual } from '../src/secrets.js';

const SECRET = 'test-cron-secret';

function cronRequest(authorization?: string): Request {
  const headers = authorization === undefined ? undefined : { authorization };
  return new Request('https://app.example/api/cron/snapshot', { headers });
}

describe('secretsEqual', () => {
  it.each([
    [SECRET, SECRET, true],
    [SECRET, `${SECRET}x`, false],
    ['test-cron-secreT', SECRET, false],
    ['', '', false],
    [null, SECRET, false],
    [SECRET, undefined, false],
    [undefined, undefined, false],
  ])('compares %j with %j as %s', (provided, expected, isEqual) => {
    expect(secretsEqual({ provided, expected })).toBe(isEqual);
  });
});

describe('isBearerAuthorized', () => {
  it.each([
    [`Bearer ${SECRET}`, true],
    [`bearer ${SECRET}`, true],
    [`Bearer wrong`, false],
    [SECRET, false],
    [`Basic ${SECRET}`, false],
    ['Bearer ', false],
  ])('reads %j as authorized: %s', (authorization, isAuthorized) => {
    expect(isBearerAuthorized({ headers: new Headers({ authorization }), secret: SECRET })).toBe(
      isAuthorized,
    );
  });

  it('matches a secret stored with a trailing newline', () => {
    const headers = new Headers({ authorization: `Bearer ${SECRET}` });

    expect(isBearerAuthorized({ headers, secret: `${SECRET}\n` })).toBe(true);
  });

  it('authorizes nothing while the secret is unset', () => {
    const headers = new Headers({ authorization: 'Bearer ' });

    expect(isBearerAuthorized({ headers, secret: undefined })).toBe(false);
    expect(isBearerAuthorized({ headers, secret: '' })).toBe(false);
  });
});

describe('requireCronSecret', () => {
  it('lets a request with the secret through', () => {
    expect(
      requireCronSecret({ request: cronRequest(`Bearer ${SECRET}`), secret: SECRET }),
    ).toBeNull();
  });

  it.each([
    ['no header', undefined],
    ['a wrong secret', 'Bearer not-the-secret'],
  ])('refuses %s with 401', (_case, authorization) => {
    const refusal = requireCronSecret({ request: cronRequest(authorization), secret: SECRET });

    expect(refusal?.status).toBe(401);
  });

  it.each([undefined, '', '   '])(
    'refuses everything with 503 while the secret is %j',
    (secret) => {
      const refusal = requireCronSecret({ request: cronRequest(`Bearer ${secret ?? ''}`), secret });

      expect(refusal?.status).toBe(503);
    },
  );
});
