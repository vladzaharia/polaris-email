//go:build !windows

package state

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// Unlock releases a previously-acquired file lock and closes the lock file
// handle. It is safe to call from a defer; it never panics.
type Unlock func() error

// Lock acquires a flock(2) on `<state-path>.lock`. If exclusive is true
// LOCK_EX is requested; otherwise LOCK_SH. The call blocks until the lock
// is acquired (or fails). The returned Unlock releases the lock and
// closes the file descriptor.
//
// Callers must hold the exclusive lock for the duration of any read-
// modify-write of the state file (a "phase"). Reads that are happy with a
// possibly-stale snapshot can use the shared lock.
//
// Windows builds get a no-op shim in lock_windows.go because Windows has
// no flock(2). Operators on Windows must serialize phases externally
// (e.g. by not running two `setup infra` invocations against the same
// .deploy-state.json concurrently). This is consistent with how POSIX-
// only operator tooling is treated in the Go ecosystem.
func (s *Store) Lock(exclusive bool) (Unlock, error) {
	lockPath := s.path + ".lock"
	// Create with 0600 so the lock file inherits the same access constraints
	// as the state file.
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("state: open lock %s: %w", lockPath, err)
	}
	op := unix.LOCK_SH
	if exclusive {
		op = unix.LOCK_EX
	}
	if err := unix.Flock(int(f.Fd()), op); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("state: flock %s: %w", lockPath, err)
	}
	return func() error {
		// Release the lock, then close the fd. We always close even if
		// the unlock errors so we don't leak file descriptors.
		unlockErr := unix.Flock(int(f.Fd()), unix.LOCK_UN)
		closeErr := f.Close()
		if unlockErr != nil {
			return unlockErr
		}
		return closeErr
	}, nil
}
