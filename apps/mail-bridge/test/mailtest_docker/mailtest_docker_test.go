//go:build mailtest_docker

package mailtest_docker

import (
	"testing"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/test/scenarios"
)

// TestAll dispatches the docker subset of scenarios. The docker harness
// trades runtime for packaging coverage: it catches Dockerfile / compose
// regressions that the inproc harness can't see (e.g. binary missing
// `tzdata`, port-mapping typos, secret-mount permissions).
//
// We run a subset because docker container startup is much slower than
// subprocess: each test pays ~5-10s for `compose up --wait`, so the
// full catalog would blow past CI budget.
func TestAll(t *testing.T) {
	factory := NewFactory(sharedCA)
	t.Run("Heartbeat", func(t *testing.T) {
		t.Run("FirstTickWithinSettle", func(t *testing.T) { scenarios.HeartbeatFirstTickWithinSettle(t, factory) })
	})
	t.Run("EnableDisable", func(t *testing.T) {
		t.Run("DisableSuspendsListeners", func(t *testing.T) { scenarios.EnableDisableSuspendsListeners(t, factory) })
		t.Run("ReenableResumesListeners", func(t *testing.T) { scenarios.EnableReenableResumesListeners(t, factory) })
	})
	t.Run("IMAPS", func(t *testing.T) {
		t.Run("AuthPlainGood", func(t *testing.T) { scenarios.IMAPSAuthPlainGood(t, factory) })
		t.Run("SelectInbox", func(t *testing.T) { scenarios.IMAPSSelectInbox(t, factory) })
	})
	t.Run("SMTPS", func(t *testing.T) {
		t.Run("AuthPlainSuccess", func(t *testing.T) { scenarios.SMTPSAuthPlainSuccess(t, factory) })
		t.Run("SubmitMessage", func(t *testing.T) { scenarios.SMTPSSubmitMessage(t, factory) })
	})
	t.Run("Webhook", func(t *testing.T) {
		t.Run("HappyPath", func(t *testing.T) { scenarios.WebhookHappyPath(t, factory) })
	})
	t.Run("EndToEnd", func(t *testing.T) {
		t.Run("SMTPInboundToIMAPRead", func(t *testing.T) { scenarios.E2ESMTPInboundToIMAPRead(t, factory) })
		t.Run("Idempotency", func(t *testing.T) { scenarios.E2EIdempotency(t, factory) })
		t.Run("IMAPIdleNotification", func(t *testing.T) { scenarios.E2EIMAPIdleNotification(t, factory) })
	})
}
