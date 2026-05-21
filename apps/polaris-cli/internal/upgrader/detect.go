package upgrader

import (
	"errors"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

// polarisModulePath is the Go module path of the polaris-cli main
// module. runtime/debug.ReadBuildInfo() returns this for any binary
// built from this module — whether by `make build` or by goreleaser.
const polarisModulePath = "github.com/vladzaharia/polaris-email/apps/polaris-cli"

// DetectInstallMethod inspects the currently-running binary path to
// figure out how it got onto disk. runningVersion is the binary's
// version banner (internal/cmds.Version); we use it to distinguish
// a `make build` artefact (Version == "dev", no goreleaser ldflag
// injection) from a tarball install at the same path.
//
// Detection order (first match wins):
//
//  1. The path (resolved through symlinks) contains a Homebrew Cellar
//     segment — `Cellar/polaris-mail/` for macOS Homebrew or
//     `linuxbrew/.linuxbrew/Cellar/polaris-mail/`.
//  2. The path lives inside a polaris-mail git checkout, identified by
//     the `apps/polaris-cli/bin/` segment AND the presence of a `.git`
//     directory in some ancestor.
//  3. The binary was built via `make build` (runtime/debug.BuildInfo's
//     Main.Path matches polarisModulePath, AND runningVersion is the
//     uninjected default "dev"). Catches the case where the operator
//     ran `make build` and copied the result to ~/.local/bin/ — the
//     binary isn't in the checkout anymore, but it's clearly a dev
//     build.
//  4. A sentinel file at `<config-dir>/install-method` exists — the
//     install.sh script writes "curl" here on a fresh install. This is
//     the disambiguator for "binary lives at /usr/local/bin/polaris-mail
//     but we don't know how it got there."
//  5. Default: InstallMethodUnknown. The upgrader will treat this like
//     curl (tarball + replace) but log a warning.
//
// configDir is `~/.config/polaris-mail` for production; tests pass a
// temp directory.
func DetectInstallMethod(configDir string, runningVersion string) (InstallMethod, error) {
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

	// Build-info heuristic. A goreleaser tarball install has
	// runningVersion set to a real semver (vX.Y.Z) via ldflag; a
	// `make build` keeps it at the package default "dev". Combined
	// with the module-path check, this catches dev binaries that have
	// been copied OUT of the checkout to ~/.local/bin/ or /usr/local/bin/.
	if isDevBuild(runningVersion) {
		return InstallMethodLocal, nil
	}

	// Sentinel-file disambiguator. Read once; never written from this
	// function (install.sh owns the write).
	if sentinel := readSentinel(configDir); sentinel != InstallMethodUnknown {
		return sentinel, nil
	}

	return InstallMethodUnknown, nil
}

// isDevBuild returns true when the running binary was produced by
// `make build` (or `go build`) rather than goreleaser. Two signals:
//
//   - runningVersion is the package default "dev" — goreleaser
//     overrides this via ldflag with the tag value (vX.Y.Z).
//   - runtime/debug.BuildInfo's main module path matches polaris-cli's
//     module path. This rules out the case where someone forks the
//     repo and renames the module — their build wouldn't be a polaris
//     dev binary.
func isDevBuild(runningVersion string) bool {
	if runningVersion != "dev" {
		return false
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return false
	}
	return info.Main.Path == polarisModulePath
}

// detectFromPath matches the resolved binary path against known
// install-location patterns. Pure function; no I/O.
//
// We use simple substring matches rather than splitting on filepath.Sep
// because Homebrew's macOS path (`/opt/homebrew/Cellar/polaris-mail/...`)
// and linuxbrew's path
// (`/home/linuxbrew/.linuxbrew/Cellar/polaris-mail/...`) both contain
// the same `Cellar/polaris-mail/` segment, and that's enough signal.
func detectFromPath(path string) InstallMethod {
	switch {
	case strings.Contains(path, filepath.FromSlash("/Cellar/polaris-mail/")),
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
