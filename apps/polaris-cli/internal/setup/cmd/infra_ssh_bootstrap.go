// `polaris-email setup infra ssh-bootstrap` — mints the impersonation
// api_key needed by `polaris-email serve --ssh` and seeds a fresh SSH
// host key (if none exists).
//
// This is the cold-start counterpart to `bin/bootstrap.sh`: that script
// mints the admin api_key (full admin:rotate); ssh-bootstrap then uses
// that admin key to issue a second, scope-limited api_key with ONLY
// `admin:impersonate`. The two-key separation is the threat-model
// foundation that keeps a compromised SSH host from escalating beyond
// "act-as registered operators".
package cmd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/ssh"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
)

// defaultSSHBootstrapOutput mirrors the bootstrap-output JSON convention.
const defaultSSHBootstrapOutput = ".ssh-bootstrap-output.json"

// sshBootstrapOutput is the small JSON shape we write to disk so a future
// `polaris-email serve --ssh` invocation can read it without re-prompting
// the operator for the impersonation bearer.
type sshBootstrapOutput struct {
	ImpersonateKeyID     string `json:"impersonate_key_id"`
	ImpersonateKeySecret string `json:"impersonate_key_secret"`
	ImpersonateBearer    string `json:"impersonate_bearer"` // polaris_{kid}.{secret}
	HostKeyPath          string `json:"host_key_path"`
	HostKeyFingerprint   string `json:"host_key_fingerprint"`
	CreatedAt            string `json:"created_at"`
}

func newInfraSSHBootstrapCmd() *cobra.Command {
	var (
		envFile         string
		bootstrapPath   string
		outputPath      string
		hostKeyPath     string
		impersonateName string
	)
	c := &cobra.Command{
		Use:   "ssh-bootstrap",
		Short: "Mint the admin:impersonate api_key + SSH host key for `serve --ssh`",
		Long: `Cold-start the Wish-fronted TUI server.

Reads .bootstrap-output.json (the admin api_key minted by ` + "`bin/bootstrap.sh`" + `)
and uses it to issue a NEW api_key whose only scope is admin:impersonate.

The resulting bearer is written to .ssh-bootstrap-output.json so
` + "`polaris-email serve --ssh`" + ` can pick it up without operator interaction.

Additionally, generates an ED25519 SSH host key at the configured path
(default ~/.config/polaris-email/ssh_host_ed25519) if one doesn't exist.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			cfg, _ := config.LoadOrDefault(envFile)
			baseURL := resolveAPIBaseURL(cfg)
			if baseURL == "" {
				return errors.New("no API base URL: set POLARIS_API_HOSTNAME in .env.deploy or POLARIS_API_BASE_URL in env")
			}
			admin, err := loadAdminClient(baseURL, bootstrapPath)
			if err != nil {
				return fmt.Errorf("admin api_key not available (%w) — run `polaris-email setup infra genesis-seal` first", err)
			}

			// 1. Mint the impersonation api_key. This still needs a mailbox
			//    to anchor the principal — the operators sentinel mailbox
			//    (`_polaris_operators`, seeded by migration 0023) is the
			//    correct home, but we accept any mailbox for environments
			//    that haven't migrated yet.
			mailboxID := ""
			var mailboxes struct {
				Data []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"data"`
			}
			if err := admin.DoJSON(ctx, "GET", "/v1/admin/mailboxes", nil, nil, &mailboxes); err != nil {
				return fmt.Errorf("list mailboxes (have you migrated?): %w", err)
			}
			for _, m := range mailboxes.Data {
				if m.Name == "_polaris_operators" {
					mailboxID = m.ID
					break
				}
			}
			if mailboxID == "" && len(mailboxes.Data) > 0 {
				mailboxID = mailboxes.Data[0].ID
			}
			if mailboxID == "" {
				return errors.New("no mailbox available; apply migration 0023 then retry")
			}

			issueBody := map[string]any{
				"mailbox_id":   mailboxID,
				"display_name": impersonateName,
				"scopes":       []string{"admin:impersonate"},
			}
			var issueResp struct {
				KeyID     string `json:"key_id"`
				KeySecret string `json:"key_secret"`
			}
			if err := admin.DoJSON(ctx, "POST", "/v1/admin/api-keys", nil, issueBody, &issueResp); err != nil {
				return fmt.Errorf("mint impersonation api_key: %w", err)
			}

			// 2. Generate the SSH host key if missing.
			if hostKeyPath == "" {
				home, _ := os.UserHomeDir()
				hostKeyPath = filepath.Join(home, ".config", "polaris-email", "ssh_host_ed25519")
			}
			fp, err := ensureHostKey(hostKeyPath)
			if err != nil {
				return fmt.Errorf("ensure host key: %w", err)
			}

			// 3. Write the output JSON.
			out := sshBootstrapOutput{
				ImpersonateKeyID:     issueResp.KeyID,
				ImpersonateKeySecret: issueResp.KeySecret,
				ImpersonateBearer:    "polaris_" + issueResp.KeyID + "." + issueResp.KeySecret,
				HostKeyPath:          hostKeyPath,
				HostKeyFingerprint:   fp,
				CreatedAt:            time.Now().UTC().Format(time.RFC3339),
			}
			raw, err := json.MarshalIndent(out, "", "  ")
			if err != nil {
				return err
			}
			if err := os.WriteFile(outputPath, raw, 0o600); err != nil {
				return fmt.Errorf("write %s: %w", outputPath, err)
			}

			fmt.Fprintf(cmd.OutOrStdout(), "✓ wrote %s\n", outputPath)
			fmt.Fprintf(cmd.OutOrStdout(), "  impersonate key id: %s\n", issueResp.KeyID)
			fmt.Fprintf(cmd.OutOrStdout(), "  host key path:      %s\n", hostKeyPath)
			fmt.Fprintf(cmd.OutOrStdout(), "  host fingerprint:   %s\n", fp)
			fmt.Fprintln(cmd.OutOrStdout())
			fmt.Fprintln(cmd.OutOrStdout(), "Next:")
			fmt.Fprintln(cmd.OutOrStdout(), "  polaris-email operator add        # register the first human operator")
			fmt.Fprintln(cmd.OutOrStdout(), "  polaris-email serve --ssh \\")
			fmt.Fprintln(cmd.OutOrStdout(), "    --bootstrap-token "+out.ImpersonateBearer)
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&bootstrapPath, "bootstrap-output", defaultBootstrapOutput, "path to .bootstrap-output.json (admin api_key)")
	c.Flags().StringVar(&outputPath, "output", defaultSSHBootstrapOutput, "where to write the impersonation bearer JSON")
	c.Flags().StringVar(&hostKeyPath, "host-key", "", "SSH host key path (default ~/.config/polaris-email/ssh_host_ed25519)")
	c.Flags().StringVar(&impersonateName, "name", "wish-bootstrap", "display name for the impersonation api_key")
	return c
}

// ensureHostKey returns the SHA256 fingerprint of the host key at path,
// generating a fresh ED25519 key if no file exists. The file mode is
// always 0o600.
func ensureHostKey(path string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	var pkPem []byte
	if data, err := os.ReadFile(path); err == nil {
		pkPem = data
	} else {
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return "", fmt.Errorf("generate ed25519: %w", err)
		}
		pkBlock, err := ssh.MarshalPrivateKey(priv, "polaris-email-host")
		if err != nil {
			return "", fmt.Errorf("marshal private key: %w", err)
		}
		pkPem = pem.EncodeToMemory(pkBlock)
		if err := os.WriteFile(path, pkPem, 0o600); err != nil {
			return "", fmt.Errorf("write %s: %w", path, err)
		}
	}
	signer, err := ssh.ParsePrivateKey(pkPem)
	if err != nil {
		return "", fmt.Errorf("parse host key: %w", err)
	}
	return ssh.FingerprintSHA256(signer.PublicKey()), nil
}

