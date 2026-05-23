import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/client/lib/safe-next.js';

describe('safeNext', () => {
  it('accepts ordinary same-origin pathnames', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/domains')).toBe('/domains');
    expect(safeNext('/domains/example.com')).toBe('/domains/example.com');
    expect(safeNext('/mailboxes?tab=senders')).toBe('/mailboxes?tab=senders');
    expect(safeNext('/abuse?tab=triage&q=foo')).toBe('/abuse?tab=triage&q=foo');
  });

  it('rejects null, undefined, and empty', () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('')).toBeNull();
  });

  it('rejects absolute URLs', () => {
    expect(safeNext('https://evil.com/path')).toBeNull();
    expect(safeNext('http://localhost/foo')).toBeNull();
    expect(safeNext('javascript:alert(1)')).toBeNull();
  });

  it('rejects protocol-relative URLs', () => {
    expect(safeNext('//evil.com')).toBeNull();
    expect(safeNext('//evil.com/path')).toBeNull();
  });

  it('rejects backslash-prefixed paths (legacy IE traversal)', () => {
    expect(safeNext('/\\evil.com')).toBeNull();
  });

  it('rejects /login* to prevent self-redirect loops', () => {
    expect(safeNext('/login')).toBeNull();
    expect(safeNext('/login?error=x')).toBeNull();
    expect(safeNext('/login/foo')).toBeNull();
  });

  it('accepts /login-lookalike paths that are NOT the login route', () => {
    // /loginsomething is a different route — must not be conflated with /login.
    expect(safeNext('/loginsomething')).toBe('/loginsomething');
  });

  it('rejects paths longer than 256 chars', () => {
    expect(safeNext('/' + 'a'.repeat(256))).toBeNull();
    expect(safeNext('/' + 'a'.repeat(255))).toBe('/' + 'a'.repeat(255));
  });

  it('rejects paths that do not start with /', () => {
    expect(safeNext('domains')).toBeNull();
    expect(safeNext('?foo=bar')).toBeNull();
    expect(safeNext(' /domains')).toBeNull();
  });
});
