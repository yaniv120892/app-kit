import type {
  BrowserFeature,
  SecurityHeader,
  SecurityHeadersOptions,
} from './security-headers.types.js';

export type {
  BrowserFeature,
  SecurityHeader,
  SecurityHeadersOptions,
} from './security-headers.types.js';

const FRAME_ANCESTORS_DIRECTIVE = 'frame-ancestors';
const DENY_FRAMING = `${FRAME_ANCESTORS_DIRECTIVE} 'none'`;
const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;
const BROWSER_FEATURES = {
  camera: true,
  microphone: true,
  geolocation: true,
} satisfies Record<BrowserFeature, true>;

/**
 * The headers every page gets: no framing, no MIME sniffing, the origin only on cross-site
 * requests, HTTPS only, and no camera, microphone or location unless the app asks. The script and
 * style parts of a content security policy stay with the app, which knows what it loads.
 *
 * List it first in `headers()`: when two entries match a path and set the same header, Next keeps
 * the later one, so a path-specific `Referrer-Policy` listed after it still wins.
 */
export function securityHeaders({
  contentSecurityPolicy = '',
  allowedFeatures = [],
}: SecurityHeadersOptions = {}): SecurityHeader[] {
  return [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Content-Security-Policy', value: withFramingDenied(contentSecurityPolicy) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: `max-age=${TWO_YEARS_SECONDS}` },
    { key: 'Permissions-Policy', value: permissionsPolicy(allowedFeatures) },
  ];
}

function withFramingDenied(contentSecurityPolicy: string): string {
  const directives = contentSecurityPolicy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '');
  const namesFrameAncestors = directives.some(
    (directive) => directive.split(/\s+/)[0]?.toLowerCase() === FRAME_ANCESTORS_DIRECTIVE,
  );
  return (namesFrameAncestors ? directives : [...directives, DENY_FRAMING]).join('; ');
}

function permissionsPolicy(allowedFeatures: BrowserFeature[]): string {
  return Object.keys(BROWSER_FEATURES)
    .map(
      (feature) =>
        `${feature}=${allowedFeatures.some((allowed) => allowed === feature) ? '(self)' : '()'}`,
    )
    .join(', ');
}
