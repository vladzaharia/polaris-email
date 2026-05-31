// Package mailtest is the shared harness for the mail-bridge integration
// test suites (mailtest_inproc, mailtest_docker, mailtest_contract).
//
// It defines the Harness + FakeControlPlane interfaces that scenario
// bodies are written against, an in-process Go fake control plane that
// implements every bridge-facing endpoint, helpers for spawning SMTPS /
// IMAPS clients against a bridge, and a tiny TLS CA for minting per-test
// server certs.
//
// Suite-specific harnesses (subprocess management, docker compose,
// wrangler dev) live in sibling packages and provide a HarnessFactory
// that the suite's *_test.go wires into scenarios.RunAll.
package mailtest

import (
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
)

// Bridge identifies a bridge registered with the (fake or real) control
// plane. The HMACKey is the plaintext secret the harness will write to
// the bridge's on-disk key file before spawning the binary.
type Bridge struct {
	ID      string
	Name    string
	HMACKey []byte
}

// Mailbox is a logical destination on the bridge.
type Mailbox struct {
	ID        string
	OwnerAddr string
}

// Credential is a stored bcrypted password for a (Mailbox, protocol, username)
// triple. Used by IMAP LOGIN and SMTPS AUTH PLAIN.
type Credential struct {
	ID         string
	MailboxID  string
	Protocol   string // "imap" or "smtp"
	Username   string
	BcryptHash string
}

// SeedMailbox / SeedCredential / SeedMessage describe initial fixtures
// for HarnessOpts. They mirror the fake's setup API and let tests
// declare initial state before Start().
type SeedMailbox struct {
	OwnerAddr string
}

type SeedCredential struct {
	MailboxOwnerAddr string
	Username         string
	Password         string
	Protocol         string // "imap" or "smtp"
}

type SeedMessage struct {
	MailboxID       string
	From            string
	Subject         string
	HeaderMessageID string
	BodyBytes       int64
	Flags           []string // canonical IMAP flag strings (e.g. \Seen, \Deleted)
}

// MessageID is the unique id of a message in the fake.
type MessageID string

// DirectiveID identifies a heartbeat directive (roll_hmac, restart, …).
type DirectiveID string

// Directive is the request-side shape of a directive being enqueued onto
// the fake's per-bridge directive list. The id is auto-generated.
type Directive struct {
	Kind           string // "roll_hmac" | "restart"
	NewHMACKey     string // roll_hmac only
	GraceExpiresAt time.Time
}

// SettingsPatch carries the subset of BridgeSettings a test wants to
// override. Fields left at their zero value are not changed (the
// corresponding pointer-nil distinction matters for booleans, hence
// the pointer types).
type SettingsPatch struct {
	SMTPSEnabled        *bool
	SMTPSPort           *int
	SMTPEnabled         *bool
	SMTPPort            *int
	IMAPSEnabled        *bool
	IMAPSPort           *int
	IMAPEnabled         *bool
	IMAPPort            *int
	TLSSource           *string // "auto" | "manual"
	MaxMessageSizeBytes *int64
	MaxIMAPSessions     *int
	LogLevel            *string
	WebhookEnabled      *bool
	WebhookURLOverride  *string
}

// BridgeSettingsOverride lets tests supply the initial settings the bridge
// runs with before the first heartbeat returns server-side state.
type BridgeSettingsOverride = SettingsPatch

// WebhookPayload is the shape DeliverWebhook accepts. It mirrors the
// production WebhookEnvelope minus the EventID + OccurredAt fields
// (which the fake fills in).
type WebhookPayload struct {
	EventID    string                // optional; auto-generated if empty
	Event      string                // e.g. "message.received"
	OccurredAt time.Time             // optional; defaults to now
	Message    polarissdk.Message
}

// SubmittedMessage describes one POST /v1/messages observed by the fake.
type SubmittedMessage struct {
	BridgeID    string
	ReceivedAt  time.Time
	ContentType string
	Body        []byte
	Headers     map[string]string
}

// AuthKey identifies which key was used to sign a heartbeat — used by
// rotation tests (R1) to distinguish "still using old key" from "now
// using new key".
type AuthKey int

const (
	AuthKeyUnknown AuthKey = iota
	AuthKeyCurrent
	AuthKeyGrace // the previous key, still accepted during a staged rotation grace window
	AuthKeyRejected
)

// Heartbeat is one observed heartbeat plus a stamp of which key it was
// signed with.
type Heartbeat struct {
	ReceivedAt time.Time
	AuthKey    AuthKey
	Request    polarissdk.BridgeHeartbeatRequest
}

// DirectiveAck records that the bridge ack'd a directive on a heartbeat.
type DirectiveAck struct {
	HeartbeatAt time.Time
	Ack         polarissdk.BridgeDirectiveAck
}
