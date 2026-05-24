// Package version exposes the running bridge's build identity to the
// rest of the binary. The heartbeat ticker reads `Version` (and
// optionally `BuildInfo` if set at link time) and ships it to the
// control plane so the panel can render the deployed binary version per
// bridge without parsing logs.
package version

// Version is the semver of the mail-bridge binary. Bump on release.
// Kept as a plain const (not a `var`) so the compiler can fold it into
// log lines and metrics labels.
const Version = "0.1.0"

// BuildInfo is opaque per-build metadata (git sha, build date) intended
// to be set via `go build -ldflags "-X .../version.BuildInfo=..."`.
// Empty by default — heartbeat omits the field when unset.
var BuildInfo = ""
