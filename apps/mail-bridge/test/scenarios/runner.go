// Package scenarios holds the suite-agnostic test bodies for the
// mail-bridge integration suites. Each exported func takes a
// *testing.T and a mailtest.HarnessFactory; the per-suite test entry
// (mailtest_inproc/tier1_test.go, etc.) wires its factory and invokes
// RunAll / RunContractSuite.
//
// Bodies live in this package (not in a `_test.go` file) so they can be
// imported by the per-suite test files in sibling packages — Go forbids
// cross-package imports of `_test.go`.
package scenarios

import (
	"testing"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

// RunAll runs the complete catalog. mailtest_inproc invokes this.
func RunAll(t *testing.T, factory mt.HarnessFactory) {
	t.Helper()
	t.Run("Heartbeat", func(t *testing.T) { runHeartbeatSuite(t, factory) })
	t.Run("EnableDisable", func(t *testing.T) { runEnableDisableSuite(t, factory) })
	t.Run("Settings", func(t *testing.T) { runSettingsSuite(t, factory) })
	t.Run("Diagnostics", func(t *testing.T) { runDiagnosticsSuite(t, factory) })
	t.Run("IMAPS", func(t *testing.T) { runIMAPSSuite(t, factory) })
	t.Run("SMTPS", func(t *testing.T) { runSMTPSSuite(t, factory) })
	t.Run("Webhook", func(t *testing.T) { runWebhookSuite(t, factory) })
	t.Run("HMACRotation", func(t *testing.T) { runHMACRotationSuite(t, factory) })
	t.Run("SMTPSecurity", func(t *testing.T) { runSMTPSecuritySuite(t, factory) })
	t.Run("TLSLifecycle", func(t *testing.T) { runTLSLifecycleSuite(t, factory) })
	t.Run("EndToEnd", func(t *testing.T) { runEndToEndSuite(t, factory) })
}

// RunContractSuite runs the curated subset that exercises wire-format
// contract correctness; used by mailtest_contract (Tier 3) where
// scenarios needing fake-only state are skipped.
func RunContractSuite(t *testing.T, factory mt.HarnessFactory) {
	t.Helper()
	t.Run("Heartbeat", func(t *testing.T) {
		t.Run("FirstTickWithinSettle", func(t *testing.T) { HeartbeatFirstTickWithinSettle(t, factory) })
		t.Run("RequestShape", func(t *testing.T) { HeartbeatRequestShape(t, factory) })
		t.Run("HMACSigning", func(t *testing.T) { HeartbeatHMACSigning(t, factory) })
	})
	t.Run("SMTPS", func(t *testing.T) {
		t.Run("SubmitMessage", func(t *testing.T) { SMTPSSubmitMessage(t, factory) })
	})
	t.Run("Webhook", func(t *testing.T) {
		t.Run("HappyPath", func(t *testing.T) { WebhookHappyPath(t, factory) })
	})
	t.Run("HMACRotation", func(t *testing.T) {
		t.Run("AppliedAndAcked", func(t *testing.T) { HMACRotationAppliedAndAcked(t, factory) })
	})
	t.Run("Settings", func(t *testing.T) {
		t.Run("StaleVersionIgnored", func(t *testing.T) { SettingsStaleVersionIgnored(t, factory) })
	})
}

// EnvDuration is a default-flag knob the harness can short-circuit
// at when callers want a different cadence per test. It's wired by
// the per-suite harness; scenarios just read fields off the opts they
// pass into factory().
