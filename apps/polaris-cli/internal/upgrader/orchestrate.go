package upgrader

import (
	"context"
	"time"
)

// State persisted across runs in ~/.config/polaris-email/config.toml.
// The config package owns the file format; this package just exposes
// the data shape it needs.
type State struct {
	// Channel is the operator's update preference. Empty = default to
	// ChannelStable at read time.
	Channel string
	// LastCheck records the last successful Check call (regardless of
	// whether an update was found). Used to throttle the launch-time
	// check so we don't hammer the GitHub API.
	LastCheck time.Time
}

// CheckInterval bounds how often we'll re-hit the GitHub API on the
// launch path. Manual `pml version upgrade` ignores it.
const CheckInterval = 1 * time.Hour

// ShouldCheck returns true if the throttle window has elapsed since
// the last check. Always true when LastCheck is the zero value
// (i.e. first launch).
func ShouldCheck(s State, now time.Time) bool {
	if s.LastCheck.IsZero() {
		return true
	}
	return now.Sub(s.LastCheck) >= CheckInterval
}

// OpportunisticCheck runs the launch-time pre-run check. Returns the
// update result (or nil if up-to-date), refreshed State to persist,
// and any error. The caller decides whether to surface errors —
// network failures during the pre-run shouldn't block the operator's
// actual command.
func OpportunisticCheck(ctx context.Context, channel Channel, currentVersion string, state State) (*Update, State, error) {
	if !ShouldCheck(state, time.Now()) {
		return nil, state, nil
	}
	upd, err := CheckLatest(ctx, channel, currentVersion)
	// Always advance LastCheck even on error — we don't want a
	// chronically-flaky network to thrash GitHub on every command.
	state.LastCheck = time.Now()
	if err != nil {
		return nil, state, err
	}
	return upd, state, nil
}
