export type SignedTokenFormatOptions = {
  /** Tells the token from a session JWT and makes a leaked one recognisable, e.g. `mia_`. */
  prefix: string;
  /** Keeps a signature for one kind of token from verifying another, e.g. `agent-token`. */
  purpose: string;
  /** Read on every call, so a rotated secret takes effect without a restart. */
  readSecret: () => string | undefined;
};

export type SignedTokenFormat = {
  /** Throws when the secret is unset: a token nobody can verify must not be handed out. */
  mint(): string;
  /** Shape and keyed suffix both check out; false for everything when the secret is unset. */
  isAuthentic(token: string): boolean;
};
