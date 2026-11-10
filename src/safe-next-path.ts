const PLACEHOLDER_ORIGIN = 'https://same-site.invalid';
const MAX_DECODE_ROUNDS = 3;
/** Browsers drop tabs and newlines inside a URL, so `/\t/evil.example` arrives as `//evil.example`. */
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;
const LEADING_DOUBLE_SLASH = /^[/\\]{2}/;

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
 * The value and each percent-decoding of it, or null when decoding never settles. A malformed
 * escape (a literal `%` in a query) ends the decoding: no reader can decode past it either.
 */
function decodedFormsOf(raw: string): string[] | null {
  const forms = [raw];
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const decoded = decodeOrNull(current);
    const isSettled = decoded === null || decoded === current;
    if (isSettled) {
      return forms;
    }
    forms.push(decoded);
    current = decoded;
  }
  return null;
}

function decodeOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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
