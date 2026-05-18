package upgrader

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// DetectInstallMethod inspects the currently-running binary path to
// figure out how it got onto disk. Detection order (first match wins):
//
//  1. The path (resolved through symlinks) contains a Homebrew Cellar
//     segment — `Cellar/polaris-email/` for macOS Homebrew or
//     `linuxbrew/.linuxbrew/Cellar/polaris-email/`.
//  2. The path lives inside a polaris-email git checkout, identified by
//     the `apps/polaris-cli/bin/` segment AND the presence of a `.git`
//     directory in some ancestor.
//  3. A sentinel file at `<config-dir>/install-method` exists — the
//     install.sh script writes "curl" here on a fresh install. This is
//     the disambiguator for "binary lives at /usr/local/bin/polaris-email
//     but we don't know how it got there."
//  4. Default: InstallMethodUnknown. The upgrader will treat this like
//     curl (tarball + replace) but log a warning.
//
// configDir is `~/.config/polaris-email` for production; tests pass a
// temp directory.
func DetectInstallMethod(configDir string) (InstallMethod, error) {
	exe, err := os.Executable()
	if err != nil {
		return InstallMethodUnknown, err
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		// Non-fatal: if the binary was deleted mid-execution or some
		// other oddity prevents symlink resolution, fall back to the
		// unresolved path. We've still got the literal os.Executable()
		// result to work with.
		resolved = exe
	}

	if method := detectFromPath(resolved); method != InstallMethodUnknown {
		return method, nil
	}

	// Sentinel-file disambiguator. Read once; never written from this
	// function (install.sh owns the write).
	if sentinel := readSentinel(configDir); sentinel != InstallMethodUnknown {
		return sentinel, nil
	}

	return InstallMethodUnknown, nil
}

// detectFromPath matches the resolved binary path against known
// install-location patterns. Pure function; no I/O.
//
// We use simple substring matches rather than splitting on filepath.Sep
// because Homebrew's macOS path (`/opt/homebrew/Cellar/polaris-email/...`)
// and linuxbrew's path
// (`/home/linuxbrew/.linuxbrew/Cellar/polaris-email/...`) both contain
// the same `Cellar/polaris-email/` segment, and that's enough signal.
func detectFromPath(path string) InstallMethod {
	switch {
	case strings.Contains(path, filepath.FromSlash("/Cellar/polaris-email/")),
		strings.Contains(path, filepath.FromSlash("/linuxbrew/")):
		return InstallMethodBrew
	case strings.Contains(path, filepath.FromSlash("/apps/polaris-cli/bin/")):
		// Match the repo-bin segment but ALSO verify the running
		// checkout has a `.git` ancestor. Prevents a false positive when
		// an operator manually creates that path structure outside a
		// repo (rare, but possible).
		if hasGitAncestor(path) {
			return InstallMethodLocal
		}
	}
	return InstallMethodUnknown
}

// hasGitAncestor walks up from `path` looking for a `.git` entry
// (directory OR file — submodules + worktrees use a file). Returns
// true if any ancestor has one.
func hasGitAncestor(path string) bool {
	dir := filepath.Dir(path)
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return true
		} else if !errors.Is(err, os.ErrNotExist) {
			// Permission denied or other transient — be conservative
			// and don't promote to InstallMethodLocal.
			return false
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

// readSentinel reads the install-method file the curl install script
// writes. Returns InstallMethodUnknown on any error — sentinel is
// best-effort; failures fall through to "unknown" rather than
// surfacing an upgrade-blocking error.
func readSentinel(configDir string) InstallMethod {
	if configDir == "" {
		return InstallMethodUnknown
	}
	data, err := os.ReadFile(filepath.Join(configDir, "install-method"))
	if err != nil {
		return InstallMethodUnknown
	}
	switch strings.TrimSpace(string(data)) {
	case "brew":
		return InstallMethodBrew
	case "curl":
		return InstallMethodCurl
	case "local":
		return InstallMethodLocal
	default:
		return InstallMethodUnknown
	}
}
