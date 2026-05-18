package upgrader

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// repoOwner / repoName encode the GitHub repository the upgrader reads
// releases from. Hard-coded — polaris-email isn't a polymorphic CLI
// with multiple downstream forks; if you fork it you change these too.
const (
	repoOwner = "vladzaharia"
	repoName  = "polaris-email"
)

// httpTimeout is short on purpose. The launch-time check runs against
// the GitHub API on every CLI invocation that isn't throttled; we
// can't afford to block startup for more than ~3 seconds total on a
// flaky network.
var httpTimeout = 3 * time.Second

// Update describes an available upgrade. Nil if the running binary is
// already at the desired version.
type Update struct {
	// Channel is the channel this update is sourced from.
	Channel Channel
	// CurrentVersion is the running binary's version banner (the
	// internal/cmds.Version value).
	CurrentVersion string
	// LatestVersion is the tag name on the resolved release
	// (e.g. "v0.1.1", or "dev" for the dev channel).
	LatestVersion string
	// AssetURL points at the goreleaser tarball for the current OS/arch.
	AssetURL string
	// AssetName is the tarball filename used to look up the entry in
	// `checksums.txt`.
	AssetName string
	// ChecksumsURL is the URL to `checksums.txt` for SHA-256 verification.
	ChecksumsURL string
}

// CheckLatest resolves the latest release for the requested channel.
// Returns (nil, nil) if the running binary is already up-to-date.
// currentVersion is typically internal/cmds.Version — passed in to
// keep this package free of import cycles.
func CheckLatest(ctx context.Context, channel Channel, currentVersion string) (*Update, error) {
	tag, err := resolveTag(ctx, channel)
	if err != nil {
		return nil, err
	}

	// Normalise both sides for comparison — we accept both `v0.1.1` and
	// `0.1.1` in the running binary's banner. The release tag is the
	// authoritative format.
	if normalise(tag) == normalise(currentVersion) {
		return nil, nil
	}

	rel, err := fetchRelease(ctx, tag)
	if err != nil {
		return nil, err
	}

	name := assetName(rel.TagName)
	asset := findAsset(rel.Assets, name)
	if asset == "" {
		return nil, fmt.Errorf("upgrader: no asset matching %q in release %s", name, rel.TagName)
	}

	return &Update{
		Channel:        channel,
		CurrentVersion: currentVersion,
		LatestVersion:  rel.TagName,
		AssetURL:       asset,
		AssetName:      name,
		ChecksumsURL:   findAsset(rel.Assets, "checksums.txt"),
	}, nil
}

// resolveTag maps a Channel to a concrete release tag.
//   - stable: GitHub Releases /latest
//   - dev:    fixed `dev` tag (force-replaced on every main push by
//             .github/workflows/dev-snapshot.yml)
//   - local:  not supported here — local-channel upgrade goes through a
//             different code path (rebuild from sibling checkout, not a
//             tarball fetch).
func resolveTag(ctx context.Context, channel Channel) (string, error) {
	switch channel {
	case ChannelStable, "":
		u := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", repoOwner, repoName)
		rel, err := getRelease(ctx, u)
		if err != nil {
			return "", err
		}
		return rel.TagName, nil
	case ChannelDev:
		return "dev", nil
	case ChannelLocal:
		return "", fmt.Errorf("upgrader: local channel does not resolve a remote tag")
	default:
		return "", fmt.Errorf("upgrader: unknown channel %q", channel)
	}
}

// fetchRelease hits /releases/tags/{tag} for both stable and dev. Stable
// could short-circuit through resolveTag's already-fetched release, but
// keeping the two calls separate keeps resolveTag a pure tag-resolver.
func fetchRelease(ctx context.Context, tag string) (*release, error) {
	u := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/tags/%s", repoOwner, repoName, tag)
	return getRelease(ctx, u)
}

type release struct {
	TagName string         `json:"tag_name"`
	Assets  []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func getRelease(ctx context.Context, url string) (*release, error) {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upgrader: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("upgrader: release not found at %s", url)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("upgrader: %s: %d %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var r release
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("upgrader: decode release: %w", err)
	}
	return &r, nil
}

// assetName constructs the goreleaser tarball name for the running
// OS/arch. The tag has a leading `v` for stable releases (`v0.1.1`)
// but the archive name drops it (`polaris-email_0.1.1_darwin_arm64.tar.gz`).
// For the `dev` tag we use the literal tag — dev archives are named
// `polaris-email_dev_darwin_arm64.tar.gz` per the dev-snapshot workflow.
//
// Windows binaries are .zip; everything else is .tar.gz. Matches the
// goreleaser archive matrix in apps/polaris-cli/.goreleaser.yaml.
func assetName(tag string) string {
	version := strings.TrimPrefix(tag, "v")
	ext := "tar.gz"
	if runtime.GOOS == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("polaris-email_%s_%s_%s.%s", version, runtime.GOOS, runtime.GOARCH, ext)
}

// findAsset returns the browser_download_url for the asset matching
// `name`, or "" if no asset matches. Case-sensitive — GitHub Releases
// are stored case-as-uploaded.
func findAsset(assets []releaseAsset, name string) string {
	for _, a := range assets {
		if a.Name == name {
			return a.BrowserDownloadURL
		}
	}
	return ""
}

// normalise trims a `v` prefix + whitespace so v0.1.1 and 0.1.1
// compare equal. We deliberately do NOT use a semver library — both
// sides are produced by our own goreleaser config, so they're always
// well-formed and a literal byte equality after this strip is the right
// signal.
func normalise(v string) string {
	return strings.TrimPrefix(strings.TrimSpace(v), "v")
}
