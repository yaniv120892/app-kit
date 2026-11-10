import { describe, expect, it } from 'vitest';
import { addressClient, readClientAddress } from '../src/client-address.js';

describe('readClientAddress', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 , 10.0.0.1, 10.0.0.2', '203.0.113.7'],
    ['', 'unknown'],
    [', 10.0.0.1', 'unknown'],
  ])('reads %j as %j', (forwardedFor, expected) => {
    expect(readClientAddress(new Headers({ 'x-forwarded-for': forwardedFor }))).toBe(expected);
  });

  it('reads a request with no forwarding header as unknown', () => {
    expect(readClientAddress(new Headers())).toBe('unknown');
  });
});

describe('addressClient', () => {
  it('prefixes the address so it cannot collide with a user id', () => {
    expect(addressClient(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('ip:203.0.113.7');
  });
});
