package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
)

// adminKeyArchivePath is the 1-deep archive of replaced admin keys. It
// is held next to .bootstrap-output.json with the same mode (0600).
const adminKeyArchivePath = ".bootstrap-output.archive.json"

// rotatedAdminKey is one archived admin-key entry. The plaintext
// secret is preserved on-disk (mode 0600) so an operator who realises
// the rotation was a mistake within the 7-day overlap window can
// re-deploy the old key. After ExpiresAt the operator must clean it
// up manually — we do NOT auto-purge the file because that would
// silently lose the rollback option mid-incident.
type rotatedAdminKey struct {
	AdminKeyID     string    `json:"admin_key_id"`
	AdminKeySecret string    `json:"admin_key_secret"`
	MailboxID      string    `json:"mailbox_id,omitempty"`
	ArchivedAt     time.Time `json:"archived_at"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// newInfraRotateAdminKeyCmd wires `setup infra rotate-admin-key`. It
// is intentionally a *peer* of `setup infra secrets rotate`, not a
// child: admin-key rotation has different invariants (it mints via
// the REST API, not wrangler), different failure modes (lockout if
// the only admin key is rotated), and different archive shape
// (.bootstrap-output.archive.json, not .secrets.archive.json).
func newInfraRotateAdminKeyCmd() *cobra.Command {
	var (
		envFile           string
		bootstrapPath     string
		archivePath       string
		refuseIfOnlyKey   bool
		warningDurationDays int
	)
	c := &cobra.Command{
		Use:   "rotate-admin-key",
		Short: "Mint a new operator admin key and archive the old one (1-deep, 7d overlap)",
		Long: "Rotate the operator admin api-key:\n" +
			"\n" +
			"  1. Read the current key from .bootstrap-output.json.\n" +
			"  2. GET /v1/admin/api-keys to count existing admin keys.\n" +
			"  3. REFUSE if the current key is the only admin key in the\n" +
			"     system (you would lock yourself out). Create a second\n" +
			"     admin via the panel first, then re-run.\n" +
			"  4. POST /v1/admin/api-keys to mint a replacement bound to\n" +
			"     the same operator mailbox.\n" +
			"  5. Archive the OLD .bootstrap-output.json to\n" +
			"     .bootstrap-output.archive.json (1-deep, 7d overlap).\n" +
			"  6. Atomically replace .bootstrap-output.json with the new\n" +
			"     key. The old key is NOT auto-revoked — that's the operator's\n" +
			"     call once the new key is validated to work in production.\n",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmdContext(cmd)
			cfg, _ := config.LoadOrDefault(envFile)

			baseURL := ""
			if cfg != nil && cfg.PolarisAPIHostname != "" {
				baseURL = "https://" + cfg.PolarisAPIHostname
			}
			if envURL := os.Getenv("POLARIS_API_BASE_URL"); envURL != "" {
				baseURL = envURL
			}
			if baseURL == "" {
				return errors.New("no API base URL: set POLARIS_API_HOSTNAME in .env.deploy or POLARIS_API_BASE_URL in env")
			}

			cli, err := loadAdminClient(baseURL, bootstrapPath)
			if err != nil {
				return fmt.Errorf("load admin client: %w", err)
			}

			// Re-read to capture the mailbox_id we'll re-use.
			oldBoot, err := readBootstrapOutput(bootstrapPath)
			if err != nil {
				return err
			}

			if refuseIfOnlyKey {
				count, err := countAdminKeys(ctx, cli)
				if err != nil {
					return fmt.Errorf("list admin keys: %w", err)
				}
				if count < 2 {
					return fmt.Errorf("rotate-admin-key: only %d admin key(s) exist; you would lock yourself out — create a second admin key via the panel first", count)
				}
			}

			mailboxID := oldBoot.MailboxID
			if mailboxID == "" {
				// Older .bootstrap-output.json shapes didn't include
				// mailbox_id. Surface a clear error rather than guessing.
				return errors.New("rotate-admin-key: .bootstrap-output.json has no mailbox_id; add it manually (the operator mailbox is `operator` — `SELECT id FROM mailboxes WHERE name='operator'`)")
			}

			newKey, err := mintAdminKey(ctx, cli, mailboxID)
			if err != nil {
				return fmt.Errorf("mint admin key: %w", err)
			}

			// Archive old → atomic replace new.
			archP := pickPath(archivePath, adminKeyArchivePath)
			archived := rotatedAdminKey{
				AdminKeyID:     oldBoot.AdminKeyID,
				AdminKeySecret: oldBoot.AdminKeySecret,
				MailboxID:      oldBoot.MailboxID,
				ArchivedAt:     time.Now().UTC(),
				ExpiresAt:      time.Now().UTC().Add(time.Duration(warningDurationDays) * 24 * time.Hour),
			}
			if err := writeAdminKeyArchive(archP, archived); err != nil {
				return fmt.Errorf("write archive: %w", err)
			}
			newBoot := bootstrapOutput{
				AdminKeyID:     newKey.AdminKeyID,
				AdminKeySecret: newKey.AdminKeySecret,
				MailboxID:      mailboxID,
				CreatedAt:      time.Now().UTC().Format(time.RFC3339),
			}
			if err := writeBootstrapOutput(bootstrapPath, newBoot); err != nil {
				return fmt.Errorf("write bootstrap-output: %w", err)
			}

			fmt.Fprintf(cmd.OutOrStdout(),
				"rotate-admin-key: minted %s; archived %s to %s (expires %s)\n",
				newKey.AdminKeyID, archived.AdminKeyID, archP, archived.ExpiresAt.Format(time.RFC3339))
			fmt.Fprintln(cmd.OutOrStdout(),
				"note: the OLD admin key is NOT revoked automatically. "+
					"Verify the new key works end-to-end, then revoke the old key from the panel "+
					"(or `polaris-email cred revoke <id>`).")
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&bootstrapPath, "bootstrap-output", defaultBootstrapOutput, "path to .bootstrap-output.json")
	c.Flags().StringVar(&archivePath, "archive-path", "", "override .bootstrap-output.archive.json path")
	c.Flags().BoolVar(&refuseIfOnlyKey, "refuse-if-only-key", true, "refuse to rotate if the current key is the only admin key (default: true)")
	c.Flags().IntVar(&warningDurationDays, "warning-days", 7, "how long the archived key stays usable for emergency rollback (days)")
	return c
}

// readBootstrapOutput reads + parses .bootstrap-output.json.
func readBootstrapOutput(path string) (bootstrapOutput, error) {
	var bo bootstrapOutput
	data, err := os.ReadFile(path)
	if err != nil {
		return bo, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &bo); err != nil {
		return bo, fmt.Errorf("parse %s: %w", path, err)
	}
	if bo.AdminKeyID == "" || bo.AdminKeySecret == "" {
		return bo, fmt.Errorf("%s missing admin_key_id or admin_key_secret", path)
	}
	return bo, nil
}

// writeBootstrapOutput atomically replaces the bootstrap-output file
// with `bo`. Mode 0600 — same posture as the original bootstrap
// writer.
func writeBootstrapOutput(path string, bo bootstrapOutput) error {
	data, err := json.MarshalIndent(bo, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWriteFile(path, data, 0o600)
}

// writeAdminKeyArchive replaces the archive (1-deep). Mode 0600.
func writeAdminKeyArchive(path string, entry rotatedAdminKey) error {
	data, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWriteFile(path, data, 0o600)
}

// atomicWriteFile is a small temp+rename helper. Local copy here so
// the rotate-admin-key flow doesn't pick up the secrets package's
// version (different module path).
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".rotate-admin-*.tmp")
	if err != nil {
		return err
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		cleanup()
		return err
	}
	return nil
}

// countAdminKeys hits GET /v1/admin/api-keys and counts non-revoked
// rows. We don't use a stricter filter because "primary" + "secondary"
// are both legitimately usable; only "revoked" rows are excluded.
func countAdminKeys(ctx context.Context, cli *client.Client) (int, error) {
	var resp struct {
		Data []struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := cli.DoJSON(ctx, "GET", "/v1/admin/api-keys", url.Values{}, nil, &resp); err != nil {
		return 0, err
	}
	count := 0
	for _, row := range resp.Data {
		if row.Status != "revoked" {
			count++
		}
	}
	return count, nil
}

// adminKeyMintResp is the subset of the issue-key response we care
// about.
type adminKeyMintResp struct {
	AdminKeyID     string `json:"key_id"`
	AdminKeySecret string `json:"key_secret"`
}

// mintAdminKey calls POST /v1/admin/api-keys with the admin scopes.
// Mirrors the bootstrap-shape key (scopes: admin:rotate, admin:read).
func mintAdminKey(ctx context.Context, cli *client.Client, mailboxID string) (adminKeyMintResp, error) {
	body := map[string]any{
		"mailbox_id":         mailboxID,
		"display_name":       "operator-admin (rotated)",
		"scopes":             []string{"admin:rotate", "admin:read"},
		"rate_limit_per_min": 60,
	}
	var resp adminKeyMintResp
	if err := cli.DoJSON(ctx, "POST", "/v1/admin/api-keys", nil, body, &resp); err != nil {
		return resp, err
	}
	if resp.AdminKeyID == "" || resp.AdminKeySecret == "" {
		return resp, errors.New("response missing key_id / key_secret")
	}
	return resp, nil
}
