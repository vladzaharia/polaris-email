// Package upgrader implements polaris-mail's self-upgrade pipeline:
// channel selection, install-method detection, version check, and the
// actual replace-and-re-exec flow.
//
// Two surfaces consume this:
//
//   - `polaris-mail version upgrade` / `polaris-mail version channel`
//     subcommands in internal/cmds/version.go.
//   - The PersistentPreRunE hook in internal/cmds/root.go that runs an
//     opportunistic check on every CLI invocation.
//
// The TUI integrates via internal/tui/upgradenotice, which composes the
// progress.Model surfaced here.
package upgrader

import (
	"fmt"
	"strings"
)

// Channel is the operator's update preference. It picks WHICH release
// the upgrader fetches; the install method (brew / curl / local) picks
// HOW it gets installed. The two are intentionally orthogonal —
// e.g. `channel=dev, install_method=brew` is a coherent state ("I want
// the latest main-branch build, install it via brew tap"), even though
// brew taps don't currently publish per-commit builds, so the operator
// would see a no-op until we wire dev-channel brew publishing.
type Channel string

const (
	// ChannelStable resolves to GitHub's `releases/latest` and is the
	// default for a fresh CLI install.
	ChannelStable Channel = "stable"
	// ChannelDev resolves to the `releases/tags/dev` release that the
	// dev-snapshot.yml workflow force-replaces on every main-branch push.
	ChannelDev Channel = "dev"
	// ChannelLocal compares against a sibling polaris-mail binary in
	// the operator's checked-out repo (apps/polaris-cli/bin/polaris-mail).
	// Used by contributors iterating on the CLI itself.
	ChannelLocal Channel = "local"
)

// AllChannels lists every valid channel value for `pml version channel
// list` and for input validation.
func AllChannels() []Channel {
	return []Channel{ChannelStable, ChannelDev, ChannelLocal}
}

// DefaultChannelFor returns the Channel that should be used when no
// explicit operator selection has been persisted yet. The rule is
// simple: a `make build` install (InstallMethodLocal) wants the
// `local` channel — operators iterating on the CLI itself don't want
// an opportunistic upgrade to silently clobber their in-flight work
// with a stable-tag download. Everything else defaults to stable.
func DefaultChannelFor(method InstallMethod) Channel {
	if method == InstallMethodLocal {
		return ChannelLocal
	}
	return ChannelStable
}

// ResolveChannel returns the channel to use given the persisted state
// and the currently-detected install method. If the operator has
// explicitly set a channel (state.Channel non-empty), that wins —
// the install-method-driven default is only used when the operator
// hasn't picked anything yet.
func ResolveChannel(stateChannel string, method InstallMethod) Channel {
	if stateChannel != "" {
		if ch, err := ParseChannel(stateChannel); err == nil {
			return ch
		}
	}
	return DefaultChannelFor(method)
}

// ParseChannel normalises operator input (case-insensitive). Empty
// strings default to ChannelStable rather than erroring — a fresh
// config.toml has no channel field set and we want the default to be
// inferred without forcing a `channel set stable` after first install.
//
// Callers that want install-method-aware defaulting (e.g. auto-pick
// `local` on a `make build` install) should use ResolveChannel
// instead.
func ParseChannel(s string) (Channel, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "stable":
		return ChannelStable, nil
	case "dev", "edge", "main":
		// Accept synonyms — `edge` is the term docker/metadata-action
		// uses for the same concept; `main` matches the branch name.
		return ChannelDev, nil
	case "local", "repo":
		return ChannelLocal, nil
	default:
		return "", fmt.Errorf("upgrader: unknown channel %q (want one of: %s)", s, strings.Join(channelStrings(), ", "))
	}
}

func channelStrings() []string {
	out := make([]string, 0, len(AllChannels()))
	for _, c := range AllChannels() {
		out = append(out, string(c))
	}
	return out
}

// InstallMethod is how the running binary got onto disk. Determined by
// path inspection in detect.go; persisted via the install.sh sentinel
// for cases where path inspection alone is ambiguous.
type InstallMethod string

const (
	// InstallMethodBrew — homebrew/linuxbrew Cellar path.
	InstallMethodBrew InstallMethod = "brew"
	// InstallMethodCurl — installed via `curl -fsSL cli.mail.plrs.im | sh`.
	// The install script writes a sentinel so we can distinguish from a
	// hand-copied curl-style install in an arbitrary directory.
	InstallMethodCurl InstallMethod = "curl"
	// InstallMethodLocal — running from a checkout's
	// apps/polaris-cli/bin/polaris-mail. Used during dev.
	InstallMethodLocal InstallMethod = "local"
	// InstallMethodUnknown — none of the above. Upgrader falls back to
	// the curl-style download path with a warning.
	InstallMethodUnknown InstallMethod = "unknown"
)
