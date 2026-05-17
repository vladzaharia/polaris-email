package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// AtomicWrite writes content to path through a sibling tempfile + rename.
// The final file has the supplied mode (caller's responsibility to pick
// 0600 for secrets, 0644 for compose files, etc).
//
// Parent directories are created with mode 0700 — the wizard always
// targets `<dir>/secrets/` for credential files, so 0700 is the right
// default for whichever parent doesn't exist yet. Callers that need a
// more permissive directory mode should MkdirAll themselves first.
func AtomicWrite(path string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmp, err)
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("fsync %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s -> %s: %w", tmp, path, err)
	}
	// os.OpenFile honors the umask which can downgrade 0600 → 0640 etc.
	// Re-chmod after the rename to make the resulting mode deterministic.
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	return nil
}

// EnsureDir creates the directory at path with the requested mode if it
// does not exist. If it does exist, the mode is enforced via chmod —
// secrets/ landing world-readable is exactly the failure mode we're
// guarding against.
func EnsureDir(path string, mode os.FileMode) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return fmt.Errorf("mkdir %s: %w", path, err)
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	return nil
}

// RejectWorldReadableDir returns an error if `path` itself is world-
// readable (mode bits include 0004). The wizard refuses to drop
// secrets into such a directory.
//
// We deliberately do NOT walk the ancestor chain: on macOS `/Users`
// is 0755 by design, and on Linux `/home` is 0755 too. A world-
// readable ancestor cannot list `path` if `path` itself is 0700/0750,
// so the only check that matters is the destination directory's own
// mode plus the secrets/ subdirectory inside it (the latter is
// enforced by EnsureDir(0o700)).
//
// Symlinks are evaluated using os.Stat (i.e. resolved) — operators
// that symlink ./polaris-bridge through a permissive bridge must fix
// the underlying target's mode, not the symlink.
func RejectWorldReadableDir(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("abs %s: %w", path, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// `path` does not exist yet — that is fine; the wizard
			// will create it with mode 0750 via EnsureDir().
			return nil
		}
		return fmt.Errorf("stat %s: %w", abs, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", abs)
	}
	if mode := info.Mode().Perm(); mode&0o004 != 0 {
		return fmt.Errorf("directory %s is world-readable (mode %#o); chmod 0750 or pick a different --dir", abs, mode)
	}
	return nil
}

// EnforceMode chmods path to mode (no-op when already equal). Used to
// remediate file modes the wizard finds on a re-run.
func EnforceMode(path string, mode os.FileMode) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() == mode {
		return nil
	}
	return os.Chmod(path, mode)
}
