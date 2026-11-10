import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../src/safe-next-path.js';

describe('safeNextPath', () => {
  it.each([
    '/',
    '/settings',
    '/join?code=AB12CD',
    '/search?q=100%25',
    '/search?q=100%',
    '/reports#month',
    '/a/b/c?next=%2Fsettings',
  ])('keeps the same-site path %j unchanged', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    ['nothing', null],
    ['nothing', undefined],
    ['an empty value', ''],
    ['an absolute URL', 'https://evil.example/'],
    ['a scheme', 'javascript:alert(1)'],
    ['a relative path', 'settings'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash after the slash', '/\\evil.example'],
    ['a backslash before the slash', '\\/evil.example'],
    ['a backslash deeper in the path', '/a\\b'],
    ['an encoded second slash', '/%2Fevil.example'],
    ['an encoded backslash', '/%5Cevil.example'],
    ['a double-encoded second slash', '/%252Fevil.example'],
    ['a tab between the slashes', '/\t/evil.example'],
    ['a newline between the slashes', '/\n/evil.example'],
    ['a carriage return', '/settings\r'],
    ['an encoded tab', '/%09/evil.example'],
    ['a NUL', '/settings%00'],
    ['DEL', '/settings\u007f'],
    ['encoding that never settles', '/%25252525252F'],
  ])('drops %s', (_case, raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });
});
