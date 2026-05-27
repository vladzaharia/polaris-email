package mailtest_inproc

import (
	"testing"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/test/scenarios"
)

// TestAll dispatches every scenario through the inproc harness.
//
// All sub-tests run sequentially so log capture / port allocation
// stays sane; Phase D's flake budget allows parallelism inside the
// scenarios themselves where they call t.Parallel.
func TestAll(t *testing.T) {
	factory := NewFactory(sharedCA)
	scenarios.RunAll(t, factory)
}
