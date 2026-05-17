package rollback

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/deploy"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wrangler"
)

// DeployOptions gates RollbackDeploy. All fields optional.
type DeployOptions struct {
	// RepoRoot is the absolute path to the polaris-email repository
	// root. Empty defaults to os.Getwd().
	RepoRoot string
	// ToVersion is the wrangler version id to roll back to. When
	// empty, the implementation uses state.Deploys[svc].PreviousVersionID
	// (if set); when neither is set the call errors out — wrangler's
	// own interactive prompt-for-version flow is intentionally NOT
	// used so the operator stays in control.
	ToVersion string
	// Reporter receives a one-shot status callback. Optional.
	Reporter func(svc, versionID string, err error)
}

// RollbackDeploy shells out to `wrangler rollback` for `svc` and
// re-stamps state so subsequent deploys carry the right ancestry.
//
// Algorithm:
//  1. Resolve the service entry (canonical deploy list).
//  2. Resolve the target version id:
//     - opts.ToVersion if non-empty
//     - state.Deploys[svc].PreviousVersionID
//     - otherwise: error (we never call `wrangler rollback` without
//       --version-id because the interactive flow blocks).
//  3. Read the current state.Deploys[svc] (so we can remember its
//     VersionID as the new PreviousVersionID).
//  4. `wrangler rollback --version-id <ToVersion> --message <msg>`
//     from the service directory.
//  5. Write state.Deploys[svc] = {VersionID: ToVersion,
//     PreviousVersionID: <previous current>, At: now}. This makes the
//     next `rollback deploy` walk back another step.
//
// The function does NOT delete the merged wrangler config or the
// .wrangler.merged.json artefact — `wrangler rollback` reads version
// metadata from the CF API, not a local wrangler.jsonc.
func RollbackDeploy(ctx context.Context, svc string, store *state.Store, opts DeployOptions) error {
	if svc == "" {
		return fmt.Errorf("rollback: service name required")
	}
	if store == nil {
		return fmt.Errorf("rollback: state store required")
	}
	svcEntry, ok := deploy.ByName(svc)
	if !ok {
		return fmt.Errorf("rollback: unknown service %q; expected one of: %s",
			svc, strings.Join(deploy.Names(), ", "))
	}
	root := opts.RepoRoot
	if root == "" {
		wd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("rollback: cwd: %w", err)
		}
		root = wd
	}

	// Lock + read state to compute the previous version id we'll roll
	// back to (if not explicitly supplied) and to capture the current
	// version id we'll demote into PreviousVersionID.
	unlock, err := store.Lock(true)
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()

	doc, err := store.Read()
	if err != nil {
		return err
	}
	cur := doc.Deploys[svc]
	target := opts.ToVersion
	if target == "" {
		target = cur.PreviousVersionID
	}
	if target == "" {
		return fmt.Errorf("rollback: no target version for %s; pass --to-version <id> or set Deploys[%s].previous_version_id", svc, svc)
	}
	if target == cur.VersionID {
		return fmt.Errorf("rollback: target version %s is already the current version for %s — nothing to roll back", target, svc)
	}

	dir := filepath.Join(root, svcEntry.Path)
	message := fmt.Sprintf("polaris-email setup rollback: %s -> %s", cur.VersionID, target)
	args := []string{"rollback",
		"--version-id", target,
		"--message", message,
	}
	// Run from the service dir so wrangler picks up the right Worker
	// name from wrangler.jsonc.
	r, runErr := wrangler.RunWithDir(ctx, dir, wrangler.Binary, nil, args...)
	if opts.Reporter != nil {
		opts.Reporter(svc, target, runErr)
	}
	if runErr != nil {
		return fmt.Errorf("rollback %s: wrangler rollback: %w", svc, runErr)
	}
	if r != nil && r.ExitCode != 0 {
		return fmt.Errorf("rollback %s: wrangler exit %d", svc, r.ExitCode)
	}

	// Re-stamp state. The PreviousVersionID becomes the version we
	// just rolled FROM (so the next rollback walks back another step
	// without an explicit --to-version).
	if doc.Deploys == nil {
		doc.Deploys = map[string]state.DeployRecord{}
	}
	doc.Deploys[svc] = state.DeployRecord{
		VersionID:         target,
		SHA:               cur.SHA,
		At:                time.Now().UTC(),
		PreviousVersionID: cur.VersionID,
	}
	return store.Write(doc)
}
