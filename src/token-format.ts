import { createHmac, randomBytes } from 'node:crypto';
import { secretsEqual } from './secrets.js';
import type { SignedTokenFormat, SignedTokenFormatOptions } from './token-format.types.js';

export type { SignedTokenFormat, SignedTokenFormatOptions } from './token-format.types.js';

const RANDOM_BYTES = 32;
/** 32 bytes in unpadded base64url. */
const BODY_LENGTH = 43;
const SIGNATURE_LENGTH = 16;
const BASE64URL = '[A-Za-z0-9_-]';

/**
 * Whether `token` is `prefix` followed by 32 random bytes in base64url, the form every app mints.
 * Run it before the database lookup, so a malformed or truncated token costs no query.
 */
export function hasTokenShape({ token, prefix }: { token: string; prefix: string }): boolean {
  return shapePattern({ prefix, suffixLength: 0 }).test(token);
}

/**
 * Tokens carrying a keyed suffix, so a forged or mistyped one is refused without a database
 * lookup. The layout is `<prefix><43-char body><16-char HMAC-SHA256 of "<purpose>:<body>">`,
 * which is what the apps already mint, so adopting this keeps every issued token valid.
 */
export function createSignedTokenFormat({
  prefix,
  purpose,
  readSecret,
}: SignedTokenFormatOptions): SignedTokenFormat {
  const pattern = shapePattern({ prefix, suffixLength: SIGNATURE_LENGTH });

  return {
    mint() {
      const secret = readSecret();
      if (!secret) {
        throw unsetSecretError({ purpose, prefix });
      }
      const body = randomBytes(RANDOM_BYTES).toString('base64url');
      return `${prefix}${body}${sign({ body, purpose, secret })}`;
    },
    isAuthentic(token) {
      const secret = readSecret();
      const hasShape = pattern.test(token);
      if (!secret || !hasShape) {
        return false;
      }
      const body = token.slice(prefix.length, prefix.length + BODY_LENGTH);
      const signature = token.slice(prefix.length + BODY_LENGTH);
      return secretsEqual({ provided: signature, expected: sign({ body, purpose, secret }) });
    },
  };
}

function sign({
  body,
  purpose,
  secret,
}: {
  body: string;
  purpose: string;
  secret: string;
}): string {
  return createHmac('sha256', secret)
    .update(`${purpose}:${body}`)
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

function unsetSecretError({ purpose, prefix }: { purpose: string; prefix: string }): Error {
  return new Error(
    `The signing secret is unset, so a ${purpose} cannot be minted (prefix: ${prefix})`,
  );
}

function shapePattern({ prefix, suffixLength }: { prefix: string; suffixLength: number }): RegExp {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedPrefix}${BASE64URL}{${BODY_LENGTH + suffixLength}}$`);
}
