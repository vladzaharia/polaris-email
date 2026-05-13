// Provider abstraction for outbound mail delivery.
//
// One implementation per backing system (Cloudflare Email Service is primary;
// SES and Postmark exist as failover targets). The Worker selects a provider
// per-message based on `domains.provider` (default: 'cloudflare').
//
// Providers receive a fully-canonicalized RFC822 message; they do not see the
// JSON request shape. All header validation, sender-domain enforcement, and
// MIME canonicalization happen upstream in `submitMessage()`.

export interface SendRequest {
  /** Full canonical RFC822 message (CRLF line endings, normalized headers). */
  rfc822: Uint8Array;
  /** Envelope sender (Return-Path will be set by the provider or its bounce MX). */
  envelopeFrom: string;
  /** Envelope recipients (one per RCPT TO). */
  envelopeTo: string[];
  /** Logical message id from `messages.id` for correlation. */
  messageId: string;
  /** Sending domain (used for binding selection / API auth). */
  fromDomain: string;
}

export type SendOutcome =
  | { kind: 'accepted'; providerMessageId?: string }
  | { kind: 'rejected'; reason: string; transient: false }
  | { kind: 'transient'; reason: string; transient: true; retryAfterMs?: number };

export interface Provider {
  /** Stable name; matches `domains.provider`. */
  name(): string;

  /**
   * Send the message. Implementations should not retry internally; transient
   * outcomes go back to the queue for the consumer to handle.
   */
  send(req: SendRequest): Promise<SendOutcome>;
}

/** Registry resolves a domain (and an env) to a Provider instance. */
export interface ProviderRegistry {
  /** Look up the provider for a given outbound domain. Falls back to default. */
  forDomain(domain: string): Provider;
  /** Look up by name (used for explicit overrides / failover testing). */
  byName(name: string): Provider | undefined;
}
