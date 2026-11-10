import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../src/security-headers.js';

function headerValue({
  name,
  headers,
}: {
  name: string;
  headers: { key: string; value: string }[];
}) {
  return headers.find((header) => header.key === name)?.value;
}

describe('securityHeaders', () => {
  it('sets the full default set', () => {
    expect(securityHeaders()).toEqual([
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ]);
  });

  it('adds framing denial to an app policy that does not set it', () => {
    const headers = securityHeaders({ contentSecurityPolicy: "default-src 'self'; img-src *;" });

    expect(headerValue({ name: 'Content-Security-Policy', headers })).toBe(
      "default-src 'self'; img-src *; frame-ancestors 'none'",
    );
  });

  it('keeps the frame-ancestors an app policy sets itself, without a contradicting XFO', () => {
    const headers = securityHeaders({
      contentSecurityPolicy: "default-src 'self'; Frame-Ancestors 'self'",
    });

    expect(headerValue({ name: 'Content-Security-Policy', headers })).toBe(
      "default-src 'self'; Frame-Ancestors 'self'",
    );
    expect(headerValue({ name: 'X-Frame-Options', headers })).toBeUndefined();
  });

  it('allows a feature the app uses for its own origin only', () => {
    const headers = securityHeaders({ allowedFeatures: ['geolocation'] });

    expect(headerValue({ name: 'Permissions-Policy', headers })).toBe(
      'camera=(), microphone=(), geolocation=(self)',
    );
  });
});
