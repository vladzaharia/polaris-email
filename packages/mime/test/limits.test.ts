import { describe, it, expect } from 'vitest';
import {
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  MAX_MESSAGE_SIZE_VERIFIED,
  MAX_MESSAGE_SIZE_UNVERIFIED,
  MAX_CUSTOM_HEADERS_PAYLOAD,
  MAX_NON_X_CUSTOM_HEADERS,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  WHITELISTED_CUSTOM_HEADERS,
  PLATFORM_CONTROLLED_HEADERS,
  USE_API_FIELD_HEADERS,
} from '../src/limits.js';

describe('numeric constants', () => {
  it('MAX_RECIPIENTS is 50', () => {
    expect(MAX_RECIPIENTS).toBe(50);
  });

  it('MAX_SUBJECT_LENGTH is 998', () => {
    expect(MAX_SUBJECT_LENGTH).toBe(998);
  });

  it('MAX_MESSAGE_SIZE_VERIFIED is 25 MiB', () => {
    expect(MAX_MESSAGE_SIZE_VERIFIED).toBe(25 * 1024 * 1024);
    expect(MAX_MESSAGE_SIZE_VERIFIED).toBe(26214400);
  });

  it('MAX_MESSAGE_SIZE_UNVERIFIED is 5 MiB', () => {
    expect(MAX_MESSAGE_SIZE_UNVERIFIED).toBe(5 * 1024 * 1024);
    expect(MAX_MESSAGE_SIZE_UNVERIFIED).toBe(5242880);
  });

  it('MAX_CUSTOM_HEADERS_PAYLOAD is 16 KiB', () => {
    expect(MAX_CUSTOM_HEADERS_PAYLOAD).toBe(16 * 1024);
    expect(MAX_CUSTOM_HEADERS_PAYLOAD).toBe(16384);
  });

  it('MAX_NON_X_CUSTOM_HEADERS is 20', () => {
    expect(MAX_NON_X_CUSTOM_HEADERS).toBe(20);
  });

  it('MAX_HEADER_NAME_LENGTH is 100', () => {
    expect(MAX_HEADER_NAME_LENGTH).toBe(100);
  });

  it('MAX_HEADER_VALUE_LENGTH is 2048', () => {
    expect(MAX_HEADER_VALUE_LENGTH).toBe(2048);
  });
});

describe('WHITELISTED_CUSTOM_HEADERS', () => {
  const expected = [
    'in-reply-to',
    'references',
    'list-unsubscribe',
    'list-unsubscribe-post',
    'list-id',
    'list-archive',
    'list-help',
    'list-owner',
    'list-post',
    'list-subscribe',
    'precedence',
    'auto-submitted',
    'content-language',
    'keywords',
    'comments',
    'importance',
    'sensitivity',
    'organization',
    'require-recipient-valid-since',
    'archived-at',
  ];

  it.each(expected)('contains %s', (name) => {
    expect(WHITELISTED_CUSTOM_HEADERS.has(name)).toBe(true);
  });

  it('has the expected size', () => {
    expect(WHITELISTED_CUSTOM_HEADERS.size).toBe(expected.length);
  });

  it('contains only lowercase entries', () => {
    for (const name of WHITELISTED_CUSTOM_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('PLATFORM_CONTROLLED_HEADERS', () => {
  const expected = [
    'date',
    'message-id',
    'mime-version',
    'content-type',
    'content-transfer-encoding',
    'dkim-signature',
    'return-path',
    'received',
    'feedback-id',
    'arc-seal',
    'arc-message-signature',
    'arc-authentication-results',
    'tls-required',
    'tls-report-domain',
    'tls-report-submitter',
    'cfbl-address',
    'cfbl-feedback-id',
  ];

  it.each(expected)('contains %s', (name) => {
    expect(PLATFORM_CONTROLLED_HEADERS.has(name)).toBe(true);
  });

  it('has the expected size', () => {
    expect(PLATFORM_CONTROLLED_HEADERS.size).toBe(expected.length);
  });

  it('contains only lowercase entries', () => {
    for (const name of PLATFORM_CONTROLLED_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('USE_API_FIELD_HEADERS', () => {
  const expected = ['from', 'to', 'cc', 'bcc', 'subject', 'reply-to'];

  it.each(expected)('contains %s', (name) => {
    expect(USE_API_FIELD_HEADERS.has(name)).toBe(true);
  });

  it('has the expected size', () => {
    expect(USE_API_FIELD_HEADERS.size).toBe(expected.length);
  });

  it('contains only lowercase entries', () => {
    for (const name of USE_API_FIELD_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('set disjointness', () => {
  it('WHITELISTED_CUSTOM_HEADERS and PLATFORM_CONTROLLED_HEADERS are disjoint', () => {
    const overlap: string[] = [];
    for (const name of WHITELISTED_CUSTOM_HEADERS) {
      if (PLATFORM_CONTROLLED_HEADERS.has(name)) overlap.push(name);
    }
    expect(overlap).toEqual([]);
  });

  it('WHITELISTED_CUSTOM_HEADERS and USE_API_FIELD_HEADERS are disjoint', () => {
    const overlap: string[] = [];
    for (const name of WHITELISTED_CUSTOM_HEADERS) {
      if (USE_API_FIELD_HEADERS.has(name)) overlap.push(name);
    }
    expect(overlap).toEqual([]);
  });

  it('PLATFORM_CONTROLLED_HEADERS and USE_API_FIELD_HEADERS are disjoint', () => {
    const overlap: string[] = [];
    for (const name of PLATFORM_CONTROLLED_HEADERS) {
      if (USE_API_FIELD_HEADERS.has(name)) overlap.push(name);
    }
    expect(overlap).toEqual([]);
  });

  it('from/to/cc/bcc/subject live only in USE_API_FIELD_HEADERS', () => {
    for (const name of ['from', 'to', 'cc', 'bcc', 'subject']) {
      expect(USE_API_FIELD_HEADERS.has(name)).toBe(true);
      expect(WHITELISTED_CUSTOM_HEADERS.has(name)).toBe(false);
      expect(PLATFORM_CONTROLLED_HEADERS.has(name)).toBe(false);
    }
  });
});
