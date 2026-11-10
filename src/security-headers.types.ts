import type { BROWSER_FEATURES } from './browser-features.js';

/** Browser features a page may ask for; each one not allowed is turned off for every origin. */
export type BrowserFeature = (typeof BROWSER_FEATURES)[number];

export type SecurityHeadersOptions = {
  /**
   * The app's own policy, e.g. `script-src 'self'`. `frame-ancestors 'none'` is appended unless
   * it already names `frame-ancestors`, so the anti-framing rule survives an app's policy. A
   * policy that names its own drops `X-Frame-Options: DENY`, which would contradict it.
   */
  contentSecurityPolicy?: string;
  /** Features the app's own pages use, allowed for the app's origin only. */
  allowedFeatures?: BrowserFeature[];
};

/** The `{ key, value }` shape `next.config` `headers()` takes. */
export type SecurityHeader = {
  key: string;
  value: string;
};
