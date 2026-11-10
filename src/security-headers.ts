import { BROWSER_FEATURES } from './browser-features.js';
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
  const directives = contentSecurityPolicy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '');
  const setsOwnFrameAncestors = directives.some(namesFrameAncestors);
  const framingHeaders: SecurityHeader[] = setsOwnFrameAncestors
    ? [{ key: 'Content-Security-Policy', value: directives.join('; ') }]
    : [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: [...directives, DENY_FRAMING].join('; ') },
      ];
  return [
    ...framingHeaders,
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: `max-age=${TWO_YEARS_SECONDS}` },
    { key: 'Permissions-Policy', value: permissionsPolicy(allowedFeatures) },
  ];
}

function namesFrameAncestors(directive: string): boolean {
  return directive.split(/\s+/)[0]?.toLowerCase() === FRAME_ANCESTORS_DIRECTIVE;
}

function permissionsPolicy(allowedFeatures: BrowserFeature[]): string {
  return BROWSER_FEATURES.map(
    (feature) => `${feature}=${allowedFeatures.includes(feature) ? '(self)' : '()'}`,
  ).join(', ');
}
