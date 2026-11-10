import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSignedTokenFormat, hasTokenShape } from '../src/token-format.js';

const SECRET = 'test-jwt-secret';
const PREFIX = 'mia_';
const PURPOSE = 'agent-token';

function formatWith(secret: string | undefined) {
  return createSignedTokenFormat({ prefix: PREFIX, purpose: PURPOSE, readSecret: () => secret });
}

/** The layout the apps mint today, written out independently of the package. */
function appMintedToken({ secret, purpose }: { secret: string; purpose: string }): string {
  const body = randomBytes(32).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${purpose}:${body}`)
    .digest('base64url')
    .slice(0, 16);
  return `${PREFIX}${body}${signature}`;
}

function withLastCharacterChanged(token: string): string {
  const last = token.at(-1) === 'A' ? 'B' : 'A';
  return `${token.slice(0, -1)}${last}`;
}

describe('createSignedTokenFormat', () => {
  it('verifies a token it minted', () => {
    const format = formatWith(SECRET);

    expect(format.isAuthentic(format.mint())).toBe(true);
  });

  it('verifies a token already minted by an app, so adoption keeps issued tokens valid', () => {
    expect(
      formatWith(SECRET).isAuthentic(appMintedToken({ secret: SECRET, purpose: PURPOSE })),
    ).toBe(true);
  });

  it('refuses a token with a forged signature', () => {
    const format = formatWith(SECRET);

    expect(format.isAuthentic(withLastCharacterChanged(format.mint()))).toBe(false);
  });

  it('refuses a token signed for another purpose', () => {
    const token = appMintedToken({ secret: SECRET, purpose: 'api-token' });

    expect(formatWith(SECRET).isAuthentic(token)).toBe(false);
  });

  const minted = formatWith(SECRET).mint();

  it.each([
    ['an empty string', ''],
    ['the prefix alone', PREFIX],
    ['a truncated token', minted.slice(0, -1)],
    ['a token with padding', `${minted}=`],
    ['another prefix', `mxk_${minted.slice(PREFIX.length)}`],
  ])('refuses %s', (_case, token) => {
    expect(formatWith(SECRET).isAuthentic(token)).toBe(false);
  });

  it('authenticates nothing and mints nothing while the secret is unset', () => {
    const token = formatWith(SECRET).mint();

    expect(formatWith(undefined).isAuthentic(token)).toBe(false);
    expect(formatWith('').isAuthentic(token)).toBe(false);
    expect(() => formatWith(undefined).mint()).toThrow(/agent-token/);
  });
});

describe('hasTokenShape', () => {
  const prefix = 'msk_mcp_';
  const wellFormed = `${prefix}${randomBytes(32).toString('base64url')}`;

  it('accepts the prefix and 32 random bytes in base64url', () => {
    expect(hasTokenShape({ token: wellFormed, prefix })).toBe(true);
  });

  it.each([
    ['a truncated token', wellFormed.slice(0, -1)],
    ['an extended token', `${wellFormed}A`],
    ['another prefix', `msk_web_${wellFormed.slice(prefix.length)}`],
    ['a character outside base64url', `${wellFormed.slice(0, -1)}+`],
  ])('rejects %s', (_case, token) => {
    expect(hasTokenShape({ token, prefix })).toBe(false);
  });

  it('matches a prefix with pattern characters literally', () => {
    const token = `a.b_${randomBytes(32).toString('base64url')}`;

    expect(hasTokenShape({ token, prefix: 'a.b_' })).toBe(true);
    expect(hasTokenShape({ token: `axb_${token.slice(4)}`, prefix: 'a.b_' })).toBe(false);
  });
});
