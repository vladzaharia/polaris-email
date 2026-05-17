package credstore

import (
	"sync"
	"time"
)

// Lockout is an in-process sliding-window counter that throttles repeated
// authentication failures per credential. The store is process-local: a
// restart resets all counters, and operators running multiple bridge
// replicas should front them with a tailnet/firewall ACL. The goal is to
// raise the cost of an online password-spray attack from "unbounded
// attempts per second" to "five attempts then a five-minute cooldown".
type Lockout struct {
	mu       sync.Mutex
	state    map[string]*lockoutState
	window   time.Duration
	limit    int
	cooldown time.Duration
}

type lockoutState struct {
	failures    []time.Time
	lockedUntil time.Time
}

// DefaultWindow / DefaultLimit / DefaultCooldown match the W3.3 policy:
// 5 failures inside 1 minute → blocked for 5 minutes. The locked state
// re-engages on every further failed attempt during the block window so
// retried-by-a-script attackers extend their own cooldown.
const (
	DefaultWindow   = 60 * time.Second
	DefaultLimit    = 5
	DefaultCooldown = 5 * time.Minute
)

// NewLockout returns a Lockout with the default thresholds.
func NewLockout() *Lockout {
	return &Lockout{
		state:    map[string]*lockoutState{},
		window:   DefaultWindow,
		limit:    DefaultLimit,
		cooldown: DefaultCooldown,
	}
}

// CheckLocked returns true if the username is currently inside a cooldown.
// Callers should reject authentication without performing the bcrypt
// comparison when this returns true.
func (l *Lockout) CheckLocked(username string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.state[username]
	if !ok {
		return false
	}
	return now.Before(st.lockedUntil)
}

// RecordFailure registers an auth failure. Returns true if this failure
// pushed the username into a cooldown.
func (l *Lockout) RecordFailure(username string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.state[username]
	if st == nil {
		st = &lockoutState{}
		l.state[username] = st
	}
	if now.Before(st.lockedUntil) {
		// Already locked; extend the cooldown so script-retry attackers
		// can't ride the boundary.
		st.lockedUntil = now.Add(l.cooldown)
		return true
	}
	// Prune failures outside the rolling window.
	cutoff := now.Add(-l.window)
	pruned := st.failures[:0]
	for _, t := range st.failures {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	st.failures = append(pruned, now)
	if len(st.failures) >= l.limit {
		st.lockedUntil = now.Add(l.cooldown)
		st.failures = nil
		return true
	}
	return false
}

// RecordSuccess clears the counter so a legitimate session after a few
// typos doesn't run up the limit on the next login.
func (l *Lockout) RecordSuccess(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.state, username)
}
