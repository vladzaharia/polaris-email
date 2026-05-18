package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
)

// newInfraConfigureCmd wires `polaris-email setup infra configure` —
// the Go port of bin/configure.sh.
//
// Modes:
//
//	(default)                  interactive huh-driven loop, save after each prompt.
//	--non-interactive          fail if any required field is missing; never prompt.
//	                           Env-overrides (CF_ACCOUNT_ID=... polaris-email setup ...)
//	                           are merged on top of the loaded file.
//	--from-file <path>         load .json / .yaml / .yml / .toml-like .env file and use
//	                           that as the source of truth. Combine with --validate
//	                           to make this a pure linting pass.
//	--validate                 run Validate() against the loaded/merged config
//	                           and exit; do not write.
//
// The "save after every prompt" durability property of the shell
// script is preserved — the prompt loop in package config calls Save
// after each accepted field, so Ctrl-C halfway is safe.
func newInfraConfigureCmd() *cobra.Command {
	var (
		envFile        string
		fromFile       string
		nonInteractive bool
		validateOnly   bool
	)
	c := &cobra.Command{
		Use:   "configure",
		Short: "Rebuild .env.deploy (interactive by default; --non-interactive for CI)",
		Long: "Rebuild the .env.deploy file polaris-email reads for cold-start.\n" +
			"\n" +
			"Default mode prompts for each field with the current value as the\n" +
			"default (matching bin/configure.sh exactly). Each accepted value\n" +
			"is persisted atomically so a Ctrl-C halfway through is safe.\n" +
			"\n" +
			"--non-interactive validates the existing file + any env-var\n" +
			"overrides without prompting; useful in CI.\n" +
			"\n" +
			"--from-file consumes a JSON/YAML blob written by `setup infra\n" +
			"state show -o json` (or any other tool) and writes the resolved\n" +
			"values into .env.deploy.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.LoadOrDefault(envFile)
			if err != nil {
				return err
			}

			// --from-file: overlay file contents on top of whatever's loaded.
			if fromFile != "" {
				overlay, err := loadOverlay(fromFile)
				if err != nil {
					return fmt.Errorf("load --from-file: %w", err)
				}
				mergeConfig(cfg, overlay)
			}

			// Env-var overrides: any matching variable in os.Environ() wins.
			// Mirrors bin/configure.sh's reliance on the surrounding shell.
			mergeEnv(cfg)

			if validateOnly {
				if err := config.Validate(cfg); err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), "ok — configuration validates cleanly")
				return nil
			}

			if nonInteractive {
				if err := config.Validate(cfg); err != nil {
					return fmt.Errorf("--non-interactive: %w", err)
				}
				if err := config.Save(envFile, cfg); err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", envFile)
				return nil
			}

			// Interactive: hand off to the huh-based prompt loop. Save
			// after each field is the durability property.
			fmt.Fprintln(cmd.OutOrStdout(),
				"polaris-email configure — values are saved to .env.deploy (gitignored) after every prompt.")
			fmt.Fprintln(cmd.OutOrStdout(),
				"Press enter to keep current values shown as placeholders. Leave optional fields blank to skip.")
			fmt.Fprintln(cmd.OutOrStdout())

			result, err := config.Prompt(cfg, config.PromptOptions{
				Path: envFile,
				Save: func(c *config.Config) error { return config.Save(envFile, c) },
			})
			if err != nil {
				return err
			}
			if err := config.Validate(result); err != nil {
				// We still wrote the file (good for the durability property),
				// but surface the validation issues for the operator.
				fmt.Fprintf(cmd.ErrOrStderr(), "warning: %v\n", err)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "\nwrote %s\n", envFile)
			return nil
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&fromFile, "from-file", "", "load values from a JSON / YAML / .env file instead of prompting")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "do not prompt; fail if required fields are missing")
	c.Flags().BoolVar(&validateOnly, "validate", false, "validate the loaded config without writing it")
	return c
}

// loadOverlay parses --from-file into a *Config. Format is detected by
// extension; we accept .json, .yaml/.yml, and .env (shell-style).
func loadOverlay(path string) (*config.Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := &config.Config{}
	switch {
	case hasSuffix(path, ".json"):
		if err := json.Unmarshal(data, out); err != nil {
			return nil, fmt.Errorf("decode json: %w", err)
		}
	case hasSuffix(path, ".yaml"), hasSuffix(path, ".yml"):
		if err := yaml.Unmarshal(data, out); err != nil {
			return nil, fmt.Errorf("decode yaml: %w", err)
		}
	case hasSuffix(path, ".env"), hasSuffix(path, ".deploy"):
		// shell-style — feed straight through the .env.deploy parser.
		return config.Load(path)
	default:
		return nil, errors.New("unrecognized --from-file extension (want .json|.yaml|.yml|.env)")
	}
	return out, nil
}

// mergeConfig writes non-empty fields from src into dst. Used by
// --from-file to overlay declared values without clobbering whatever
// was already in .env.deploy. (An empty string in src is treated as
// "no opinion" so callers can declare partial configs.)
func mergeConfig(dst, src *config.Config) {
	if src == nil {
		return
	}
	dstMap := dst.AsMap()
	srcMap := src.AsMap()
	for k, v := range srcMap {
		if v == "" {
			continue
		}
		dstMap[k] = v
	}
	// Re-hydrate dst by calling setField via the unexported helper.
	// The cleanest route is to round-trip dstMap into a fresh Config.
	*dst = config.Config{}
	for k, v := range dstMap {
		applyKey(dst, k, v)
	}
}

// mergeEnv merges any matching $KEY from the surrounding environment
// into c. This mirrors bin/configure.sh's `source "$ENV_FILE"` then
// "use whatever's in the shell" behavior. Empty env values are ignored
// — explicit-empty-via-env is a footgun, not a feature.
func mergeEnv(c *config.Config) {
	for _, k := range config.FieldOrder {
		v := os.Getenv(k)
		if v == "" {
			continue
		}
		applyKey(c, k, v)
	}
}

// applyKey writes a single (key, value) into c. Used by the merge
// helpers; centralises the schema-side switch in one place that
// schema.go also keeps up to date.
func applyKey(c *config.Config, key, value string) {
	switch key {
	case "CF_ACCOUNT_ID":
		c.CFAccountID = value
	case "POLARIS_API_HOSTNAME":
		c.PolarisAPIHostname = value
	case "CF_API_TOKEN":
		c.CFAPIToken = value
	case "CF_ZONE_ID":
		c.CFZoneID = value
	case "SYNTHETIC_MONITOR_DOMAIN":
		c.SyntheticMonitorDomain = value
	case "ALERT_WEBHOOK":
		c.AlertWebhook = value
	case "SYNTHETIC_FROM":
		c.SyntheticFrom = value
	case "SYNTHETIC_TO":
		c.SyntheticTo = value
	case "OIDC_ISSUER":
		c.OIDCIssuer = value
	case "OIDC_CLIENT_ID":
		c.OIDCClientID = value
	case "OIDC_CLIENT_SECRET":
		c.OIDCClientSecret = value
	case "R2_PUBLIC_HOST":
		c.R2PublicHost = value
	case "BRIDGE_HOST":
		c.BridgeHost = value
	}
}

// hasSuffix is a case-insensitive strings.HasSuffix.
func hasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) &&
		strings.EqualFold(s[len(s)-len(suffix):], suffix)
}
