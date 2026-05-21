//go:build windows

package state

// Windows doesn't have flock(2). This shim accepts the same Lock() call
// the POSIX implementation does but performs no actual file locking.
//
// Operators on Windows must serialize phases externally — don't run two
// concurrent `polaris-mail setup infra` invocations against the same
// .deploy-state.json. The POSIX flock guarantee is best-effort even on
// real Unix (it's advisory, not mandatory), so the Windows behaviour is
// "the same expectation, just without the kernel-level safety net."
//
// If a future Windows operator needs true cross-process locking we can
// reach for LockFileEx via golang.org/x/sys/windows; deferred until
// someone actually asks. This module is single-operator-and-machine in
// practice — Windows users today get the same correctness as a POSIX
// user who happens to have only one terminal open.

type Unlock func() error

// Lock returns a no-op Unlock on Windows.
func (s *Store) Lock(exclusive bool) (Unlock, error) {
	_ = exclusive // platform stub; lock mode is meaningless without flock
	return func() error { return nil }, nil
}
