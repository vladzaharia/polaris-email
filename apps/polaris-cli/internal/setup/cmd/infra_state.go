package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
)

// defaultStatePath is the location every setup command reads/writes
// state from. It is intentionally repo-root-relative; PR 4 will let
// `--state-path` flag override it.
const defaultStatePath = ".deploy-state.json"

// newInfraStateCmd builds the `setup infra state` subtree with three
// leaves: show, validate, rebuild.
func newInfraStateCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "state",
		Short: "Inspect, validate, or rebuild the local .deploy-state.json ledger",
	}
	c.AddCommand(newStateShowCmd(), newStateValidateCmd(), newStateRebuildCmd())
	return c
}

// --- show ------------------------------------------------------------------

func newStateShowCmd() *cobra.Command {
	var path, format string
	c := &cobra.Command{
		Use:   "show",
		Short: "Pretty-print the .deploy-state.json file",
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := resolveStatePath(path)
			if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("no state file at %s", p)
			} else if err != nil {
				return err
			}
			s := state.Open(p)
			doc, err := s.Read()
			if err != nil {
				return err
			}
			return emit(cmd, format, doc)
		},
	}
	c.Flags().StringVar(&path, "path", "", "override the state file path (default .deploy-state.json)")
	c.Flags().StringVarP(&format, "output", "o", "table", "output format: table|json|yaml")
	return c
}

// --- validate --------------------------------------------------------------

func newStateValidateCmd() *cobra.Command {
	var path string
	c := &cobra.Command{
		Use:   "validate",
		Short: "Check the state file matches the current schema version",
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := resolveStatePath(path)
			s := state.Open(p)
			doc, err := s.Read()
			if err != nil {
				return err
			}
			if doc.SchemaVersion != state.CurrentSchema {
				return fmt.Errorf("state schema mismatch: got %d, want %d (run `setup infra state rebuild` to upgrade)",
					doc.SchemaVersion, state.CurrentSchema)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "ok — schema v%d at %s\n", doc.SchemaVersion, p)
			return nil
		},
	}
	c.Flags().StringVar(&path, "path", "", "override the state file path")
	return c
}

// --- rebuild ---------------------------------------------------------------

func newStateRebuildCmd() *cobra.Command {
	var path, format, token, accountID string
	var dryRun bool
	c := &cobra.Command{
		Use:   "rebuild",
		Short: "Rebuild .deploy-state.json from a live Cloudflare account (read-only API calls)",
		Long: "Rebuild .deploy-state.json by listing every D1/R2/KV/Queues\n" +
			"resource under the configured account. Resources reconstructed\n" +
			"this way are flagged `discovered: true`.\n" +
			"\n" +
			"PR 1 ships a minimal implementation — drift detection vs an\n" +
			"existing state file lands in PR 5.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if token == "" {
				token = os.Getenv("CLOUDFLARE_API_TOKEN")
			}
			if accountID == "" {
				accountID = os.Getenv("CLOUDFLARE_ACCOUNT_ID")
			}
			if token == "" || accountID == "" {
				return fmt.Errorf("rebuild needs --token + --account-id (or $CLOUDFLARE_API_TOKEN + $CLOUDFLARE_ACCOUNT_ID)")
			}
			client := cfapi.NewClient(token, accountID)
			lister := cfapiLister{c: client}
			doc, err := state.Rebuild(context.Background(), lister, accountID)
			if err != nil {
				return err
			}
			if dryRun {
				return emit(cmd, format, doc)
			}
			p := resolveStatePath(path)
			s := state.Open(p)
			unlock, err := s.Lock(true)
			if err != nil {
				return err
			}
			defer func() { _ = unlock() }()
			if err := s.Write(doc); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "rebuilt state at %s\n", p)
			return nil
		},
	}
	c.Flags().StringVar(&path, "path", "", "override the state file path")
	c.Flags().StringVarP(&format, "output", "o", "table", "output format: table|json|yaml")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "print the rebuilt state without writing to disk")
	c.Flags().StringVar(&token, "token", "", "Cloudflare API token (overrides $CLOUDFLARE_API_TOKEN)")
	c.Flags().StringVar(&accountID, "account-id", "", "Cloudflare account ID (overrides $CLOUDFLARE_ACCOUNT_ID)")
	return c
}

// --- helpers ---------------------------------------------------------------

func resolveStatePath(override string) string {
	if override != "" {
		return override
	}
	return defaultStatePath
}

func emit(cmd *cobra.Command, format string, v *state.Doc) error {
	f, err := output.ParseFormat(format)
	if err != nil {
		return err
	}
	w := cmd.OutOrStdout()
	switch f {
	case output.FormatJSON:
		return output.EmitJSON(w, v)
	case output.FormatYAML:
		return output.EmitYAML(w, v)
	}
	// Table: render a short summary.
	renderStateSummary(cmd, v)
	return nil
}

func renderStateSummary(cmd *cobra.Command, d *state.Doc) {
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "Schema version: %d\n", d.SchemaVersion)
	if d.AccountID != "" {
		fmt.Fprintf(w, "Account:        %s\n", d.AccountID)
	}
	if !d.CreatedAt.IsZero() {
		fmt.Fprintf(w, "Created:        %s\n", d.CreatedAt.Format("2006-01-02 15:04:05 MST"))
	}
	if !d.UpdatedAt.IsZero() {
		fmt.Fprintf(w, "Updated:        %s\n", d.UpdatedAt.Format("2006-01-02 15:04:05 MST"))
	}
	if len(d.Phases) > 0 {
		fmt.Fprintln(w, "Phases:")
		for name, ph := range d.Phases {
			fmt.Fprintf(w, "  %s — completed %s\n", name, ph.CompletedAt.Format("2006-01-02 15:04:05 MST"))
		}
	}
	renderResourceMap(w, "D1", mapKeys(d.D1))
	renderResourceMap(w, "KV", mapKeys(d.KV))
	renderResourceMap(w, "Queues", mapKeys(d.Queues))
	if len(d.R2) > 0 {
		fmt.Fprintln(w, "R2:")
		for name, b := range d.R2 {
			suffix := ""
			if b.Jurisdiction != "" {
				suffix = " [" + b.Jurisdiction + "]"
			}
			fmt.Fprintf(w, "  %s%s\n", name, suffix)
		}
	}
}

func renderResourceMap(w io.Writer, label string, keys []string) {
	if len(keys) == 0 {
		return
	}
	fmt.Fprintf(w, "%s:\n", label)
	for _, k := range keys {
		fmt.Fprintf(w, "  %s\n", k)
	}
}

func mapKeys(m map[string]state.Resource) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// cfapiLister adapts *cfapi.Client to the state.CFLister interface. It
// lives here (in cmd/) rather than in cfapi/ because cfapi cannot import
// state without a circular dep.
type cfapiLister struct {
	c *cfapi.Client
}

func (l cfapiLister) ListD1Databases(ctx context.Context) ([]state.CFResource, error) {
	dbs, err := l.c.ListDatabases(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]state.CFResource, 0, len(dbs))
	for _, d := range dbs {
		out = append(out, state.CFResource{ID: d.UUID, Name: d.Name})
	}
	return out, nil
}

func (l cfapiLister) ListR2Buckets(ctx context.Context) ([]state.CFR2Bucket, error) {
	// Default jurisdiction sweep + EU sweep. The "default" call returns
	// buckets without an explicit jurisdiction marker; EU returns the
	// rest. We dedupe by name.
	seen := map[string]struct{}{}
	var all []state.CFR2Bucket
	for _, jur := range []string{"", "eu"} {
		buckets, err := l.c.ListBuckets(ctx, jur)
		if err != nil {
			// EU may legitimately be empty on accounts without an EU
			// bucket — treat 4xx as "no buckets in this jurisdiction".
			if jur != "" && cfapi.IsNotFound(err) {
				continue
			}
			return nil, err
		}
		for _, b := range buckets {
			key := strings.ToLower(b.Name)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			all = append(all, state.CFR2Bucket{
				Name:         b.Name,
				Jurisdiction: b.Jurisdiction,
				CreatedAt:    b.CreationDate,
			})
		}
	}
	return all, nil
}

func (l cfapiLister) ListKVNamespaces(ctx context.Context) ([]state.CFResource, error) {
	ns, err := l.c.ListNamespaces(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]state.CFResource, 0, len(ns))
	for _, n := range ns {
		out = append(out, state.CFResource{ID: n.ID, Name: n.Title})
	}
	return out, nil
}

func (l cfapiLister) ListQueues(ctx context.Context) ([]state.CFResource, error) {
	qs, err := l.c.ListQueues(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]state.CFResource, 0, len(qs))
	for _, q := range qs {
		out = append(out, state.CFResource{ID: q.QueueID, Name: q.QueueName})
	}
	return out, nil
}
