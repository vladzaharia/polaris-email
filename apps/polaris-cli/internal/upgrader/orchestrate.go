package upgrader

import (
	"context"
	"time"
)

// State persisted across runs in ~/.config/polaris-mail/upgrader-state.json.
// Snake-case keys, RFC3339 timestamps — friendlier for any operator who
// pokes at the file with `jq`.
type State struct {
	// Channel is the operator's update preference. Empty = default to
	// ChannelStable at read time.
	Channel string
	// LastCheck records the last successful Check call (regardless of
	// whether an update was found). Used to throttle the launch-time
	// check so we don't hammer the GitHub API.
	LastCheck time.Time
	// LastCheckResult caches what the most recent Check found.
	// `pml version` reads it to show update status without a network
	// call; `LastCheck`'s recency tells the reader whether to trust
	// it. Nil means "no upgrade was available at last check".
	LastCheckResult *CheckedUpdate
}

// CheckedUpdate is the persistent snapshot of an available update.
// Reduced surface from Update — just the bits `version` needs to
// render. Doesn't include the asset URLs because those expire (GitHub
// rotates download links) and re-resolving them is cheap when the
// operator actually runs `version upgrade`.
type CheckedUpdate struct {
	Channel        string
	CurrentVersion string
	LatestVersion  string
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
	// Cache the result for `pml version` to surface without making
	// another network call. Nil means up-to-date.
	state.LastCheckResult = nil
	if upd != nil {
		state.LastCheckResult = &CheckedUpdate{
			Channel:        string(upd.Channel),
			CurrentVersion: upd.CurrentVersion,
			LatestVersion:  upd.LatestVersion,
		}
	}
	return upd, state, nil
}
