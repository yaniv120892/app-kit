const PLACEHOLDER_ORIGIN = 'https://same-site.invalid';
const MAX_DECODE_ROUNDS = 3;
/** Browsers drop tabs and newlines inside a URL, so `/\t/evil.example` arrives as `//evil.example`. */
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;
const LEADING_DOUBLE_SLASH = /^[/\\]{2}/;
const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;

/**
 * The `?next=` path to send a user to after sign-in, or null when it could leave the site. Only a
 * path on this origin survives: absolute URLs, protocol-relative `//host`, `/\host` (which
 * browsers read as `//host`), control characters, and any of those percent-encoded are dropped.
 * The value is returned unchanged when it passes, so query and hash survive.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw?.startsWith('/')) {
    return null;
  }
  const decodedForms = decodedFormsOf(raw);
  if (decodedForms === null) {
    return null;
  }
  const isAnyFormUnsafe = decodedForms.some(isUnsafeForm);
  if (isAnyFormUnsafe) {
    return null;
  }
  const isSameOrigin = new URL(raw, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  return isSameOrigin ? raw : null;
}

/**
 * The value and each percent-decoding of it, or null when decoding never settles. Each `%XX`
 * escape is decoded on its own, so a malformed one elsewhere (a literal `%` in a query) cannot
 * hide `%2F` from the check the way a whole-string decode that throws would; lenient readers
 * decode those escapes regardless.
 */
function decodedFormsOf(raw: string): string[] | null {
  const forms = [raw];
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const decoded = current.replace(PERCENT_ESCAPE, decodeEscape);
    if (decoded === current) {
      return forms;
    }
    forms.push(decoded);
    current = decoded;
  }
  return null;
}

function decodeEscape(_escape: string, hexDigits: string): string {
  return String.fromCharCode(Number.parseInt(hexDigits, 16));
}

function isUnsafeForm(form: string): boolean {
  return hasControlCharacter(form) || form.includes('\\') || LEADING_DOUBLE_SLASH.test(form);
}

function hasControlCharacter(form: string): boolean {
  return [...form].some((character) => {
    const code = character.charCodeAt(0);
    return code <= LAST_C0_CONTROL_CODE || code === DELETE_CODE;
  });
}
