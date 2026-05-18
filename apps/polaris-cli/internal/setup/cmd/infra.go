package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/cfapi"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/config"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/deploy"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/genesis"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/migrate"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/plan"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/preflight"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/provision"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets/sources"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/smoke"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/state"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/wranglercfg"
)

// happyPathPhases is the ordered list of phases the bare `setup infra`
// runner drives. PR 7 wires every phase; --resume short-circuits past
// each phase whose CompletedAt is non-zero in .deploy-state.json.
//
// Phase names match the state-file keys deliberately so operators can
// inspect (and edit, if they really must) the resume bookmarks via
// `setup infra state show -o json`.
var happyPathPhases = []string{
	"preflight",
	"configure",
	"plan",
	"apply",
	"render",
	"migrate",
	"secrets",
	"deploy",
	"genesis-seal",
	"smoke",
}

// newInfraCmd returns the `setup infra` parent. The bare command (no
// subcommand) drives the full happy path; each leaf can also be
// invoked individually for ad-hoc maintenance.
func newInfraCmd() *cobra.Command {
	var (
		envFile        string
		statePath      string
		resume         bool
		startPhase     string
		yes            bool
		nonInteractive bool
		noBrowser      bool
		skipSmoke      bool
		webauthnToken  string
	)
	c := &cobra.Command{
		Use:   "infra",
		Short: "Provision + deploy the Cloudflare-side polaris-email infrastructure",
		Long: "Run the polaris-email cold-start happy path:\n" +
			"\n" +
			"  preflight → configure → plan → apply → render → migrate →\n" +
			"  secrets seed → deploy → genesis-seal → smoke\n" +
			"\n" +
			"Each phase records its completion to .deploy-state.json so\n" +
			"--resume short-circuits past completed phases on retry. Use\n" +
			"--phase <name> to start at a specific phase (skipping earlier\n" +
			"work; useful when an operator knows their cluster is already\n" +
			"past the early phases).\n" +
			"\n" +
			"Leaves under `setup infra` can be invoked individually for\n" +
			"ad-hoc maintenance (e.g. `setup infra migrate` to apply a new\n" +
			"D1 migration without touching the rest of the flow).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			runOpts := happyPathOpts{
				envFile:        envFile,
				statePath:      pickPath(statePath, defaultStatePath),
				resume:         resume,
				startPhase:     startPhase,
				yes:            yes,
				nonInteractive: nonInteractive,
				noBrowser:      noBrowser,
				skipSmoke:      skipSmoke,
				webauthnToken:  webauthnToken,
				out:            cmd.OutOrStdout(),
				errw:           cmd.ErrOrStderr(),
			}
			return runHappyPathInfra(ctx, runOpts)
		},
	}
	c.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "path to .env.deploy")
	c.Flags().StringVar(&statePath, "state-path", "", "override .deploy-state.json path")
	c.Flags().BoolVar(&resume, "resume", false, "skip phases already marked complete in .deploy-state.json")
	c.Flags().StringVar(&startPhase, "phase", "", "start at the named phase (skip earlier phases regardless of state)")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "skip every interactive confirmation prompt")
	c.Flags().BoolVar(&nonInteractive, "non-interactive", false, "fail rather than prompt; force PlainReporter")
	c.Flags().BoolVar(&noBrowser, "no-browser", false, "do not open the operator's browser for WebAuthn enrolment")
	c.Flags().BoolVar(&skipSmoke, "skip-smoke", false, "skip the final smoke check")
	c.Flags().StringVar(&webauthnToken, "webauthn-token", "", "headless WebAuthn-stamped JWT (skips the browser ceremony)")

	// PR 2 leaves: preflight + configure.
	c.AddCommand(newInfraPreflightCmd())
	c.AddCommand(newInfraConfigureCmd())
	// PR 1 leaf: state subtree.
	c.AddCommand(newInfraStateCmd())
	c.AddCommand(newInfraRenderCmd())
	// PR 3 leaves: plan + apply.
	c.AddCommand(newInfraPlanCmd())
	c.AddCommand(newInfraApplyCmd())
	// PR 5 leaves: secrets + migrate + deploy + smoke.
	c.AddCommand(newInfraSecretsCmd())
	c.AddCommand(newInfraMigrateCmd())
	c.AddCommand(newInfraDeployCmd())
	c.AddCommand(newInfraSmokeCmd())
	// PR 7 leaf: genesis-seal.
	c.AddCommand(newInfraGenesisSealCmd())
	// PR 13 leaves: rollback + rotate-admin-key.
	c.AddCommand(newInfraRollbackCmd())
	c.AddCommand(newInfraRotateAdminKeyCmd())
	// TUI/SSH slice leaf: SSH bootstrap (mint admin:impersonate api_key + host key).
	c.AddCommand(newInfraSSHBootstrapCmd())
	return c
}

// --- happy-path runner ----------------------------------------------

type happyPathOpts struct {
	envFile        string
	statePath      string
	resume         bool
	startPhase     string
	yes            bool
	nonInteractive bool
	noBrowser      bool
	skipSmoke      bool
	webauthnToken  string
	out            io.Writer
	errw           io.Writer
}

// runHappyPathInfra drives every phase in order. Each phase is wrapped
// in a small helper that:
//
//   - checks --resume (skip if already complete)
//   - checks --phase (skip if not yet at the start phase)
//   - prints a "→ phase X" header
//   - calls the phase function
//   - on success, records the phase as complete in .deploy-state.json
//
// Errors abort the run — partial progress is recorded so a re-run with
// --resume picks up where the failure was.
func runHappyPathInfra(ctx context.Context, o happyPathOpts) error {
	if o.startPhase != "" && !isKnownPhase(o.startPhase) {
		return fmt.Errorf("unknown --phase %q; valid phases: %s",
			o.startPhase, strings.Join(happyPathPhases, ", "))
	}

	store := state.Open(o.statePath)

	// Build a phase → enabled? map from --phase. Everything before the
	// start phase is implicitly skipped.
	enabled := map[string]bool{}
	reached := o.startPhase == ""
	for _, p := range happyPathPhases {
		if !reached && p == o.startPhase {
			reached = true
		}
		enabled[p] = reached
	}

	// Secrets seed produces an in-memory map keyed by secret name; the
	// genesis-seal phase consumes POLARIS_SECRET_A out of this map so
	// the value never lands on disk. Pre-seeded so a --phase=genesis-seal
	// run picks up POLARIS_SECRET_A from the environment if available.
	seededSecrets := map[string]string{}
	if v := os.Getenv("POLARIS_SECRET_A"); v != "" {
		seededSecrets["POLARIS_SECRET_A"] = v
	}

	type phaseFn func(context.Context) error
	phases := map[string]phaseFn{
		"preflight": func(c context.Context) error { return phasePreflight(c, o) },
		"configure": func(c context.Context) error { return phaseConfigure(c, o) },
		"plan":      func(c context.Context) error { return phasePlan(c, o, store) },
		"apply":     func(c context.Context) error { return phaseApply(c, o, store) },
		"render":    func(c context.Context) error { return phaseRender(c, o, store) },
		"migrate":   func(c context.Context) error { return phaseMigrate(c, o, store) },
		"secrets":   func(c context.Context) error { return phaseSecrets(c, o, store, seededSecrets) },
		"deploy":    func(c context.Context) error { return phaseDeploy(c, o, store) },
		"genesis-seal": func(c context.Context) error {
			return phaseGenesisSeal(c, o, store, seededSecrets)
		},
		"smoke": func(c context.Context) error {
			if o.skipSmoke {
				fmt.Fprintln(o.out, "smoke: skipped (--skip-smoke)")
				return nil
			}
			return phaseSmoke(c, o)
		},
	}

	for _, name := range happyPathPhases {
		if !enabled[name] {
			fmt.Fprintf(o.out, "↷ %s (skipped by --phase=%s)\n", name, o.startPhase)
			continue
		}
		if o.resume && phaseAlreadyComplete(store, name) {
			fmt.Fprintf(o.out, "✓ %s (already complete; --resume)\n", name)
			continue
		}
		fmt.Fprintf(o.out, "\n→ %s\n", name)
		fn, ok := phases[name]
		if !ok {
			return fmt.Errorf("internal: no runner for phase %q", name)
		}
		if err := fn(ctx); err != nil {
			return fmt.Errorf("phase %s: %w", name, err)
		}
		if err := stampPhase(store, name); err != nil {
			fmt.Fprintf(o.errw, "warning: failed to record phase %s completion: %v\n", name, err)
		}
	}
	fmt.Fprintln(o.out, "\nsetup infra: complete")
	return nil
}

// --- phase implementations -------------------------------------------

func phasePreflight(ctx context.Context, o happyPathOpts) error {
	cfg, _ := config.LoadOrDefault(o.envFile)
	checks := assembleChecks(cfg, o.envFile, "", false)
	results, sum := preflight.Run(ctx, checks, false)
	preflight.RenderText(o.out, results, sum)
	if sum.HasFail() {
		return errors.New("preflight failed (re-run `setup infra preflight` for details)")
	}
	return nil
}

func phaseConfigure(_ context.Context, o happyPathOpts) error {
	if _, err := os.Stat(o.envFile); err == nil {
		// .env.deploy exists — validate it. We do NOT re-prompt the
		// operator from the happy path because that would block on
		// huh, and the happy path is supposed to be ergonomic in both
		// interactive and CI runs. Operators who want a fresh
		// .env.deploy run `setup infra configure` explicitly.
		cfg, err := config.LoadOrDefault(o.envFile)
		if err != nil {
			return err
		}
		if err := config.Validate(cfg); err != nil {
			return fmt.Errorf("configure: %w (run `setup infra configure` to fix)", err)
		}
		fmt.Fprintf(o.out, "configure: validated %s\n", o.envFile)
		return nil
	}
	if o.nonInteractive {
		return fmt.Errorf("configure: %s missing and --non-interactive set", o.envFile)
	}
	// Hand off to the interactive prompt loop.
	cfg, _ := config.LoadOrDefault(o.envFile)
	result, err := config.Prompt(cfg, config.PromptOptions{
		Path: o.envFile,
		Save: func(c *config.Config) error { return config.Save(o.envFile, c) },
	})
	if err != nil {
		return err
	}
	if err := config.Validate(result); err != nil {
		return err
	}
	fmt.Fprintf(o.out, "configure: wrote %s\n", o.envFile)
	return nil
}

func phasePlan(ctx context.Context, o happyPathOpts, store *state.Store) error {
	cfg, _ := config.LoadOrDefault(o.envFile)
	tok, acct := resolveCFCreds("", "", cfg)
	if tok == "" || acct == "" {
		return errors.New("plan: missing CF_API_TOKEN + CF_ACCOUNT_ID")
	}
	client := cfapi.NewClient(tok, acct)
	snap, err := LiveSnapshot(ctx, client)
	if err != nil {
		return err
	}
	doc, err := store.Read()
	if err != nil {
		return err
	}
	p := plan.Diff(plan.Desired(), doc, snap)
	plan.Render(o.out, p)
	return nil
}

func phaseApply(ctx context.Context, o happyPathOpts, store *state.Store) error {
	// During the soak window the apply phase enforces
	// POLARIS_SETUP_PROVISION=1. The happy path inherits this gate —
	// operators who haven't opted in run `make bootstrap` (legacy
	// shell path) instead.
	if v := os.Getenv(provisionOptInEnv); v != "1" && v != "true" {
		return fmt.Errorf(
			"%s is not set — refusing to provision during the soak window.\n"+
				"Set %s=1 to promote the Go provision path over bin/bootstrap.sh.",
			provisionOptInEnv, provisionOptInEnv,
		)
	}
	cfg, _ := config.LoadOrDefault(o.envFile)
	tok, acct := resolveCFCreds("", "", cfg)
	if tok == "" || acct == "" {
		return errors.New("apply: missing CF_API_TOKEN + CF_ACCOUNT_ID")
	}
	client := cfapi.NewClient(tok, acct)
	snap, err := LiveSnapshot(ctx, client)
	if err != nil {
		return err
	}
	doc, err := store.Read()
	if err != nil {
		return err
	}
	p := plan.Diff(plan.Desired(), doc, snap)
	if !p.HasCreates() && len(p.Adopt) == 0 {
		fmt.Fprintln(o.out, "apply: nothing to do")
		return nil
	}
	rep := provision.NewPlainReporter(o.out)
	return provision.Apply(ctx, client, store, p, rep)
}

func phaseRender(_ context.Context, o happyPathOpts, store *state.Store) error {
	doc, err := store.Read()
	if err != nil {
		return err
	}
	in, err := wranglercfg.LoadInputs(doc, o.envFile)
	if err != nil {
		return err
	}
	if err := in.Validate(); err != nil {
		return err
	}
	// Render every service that has a template. We don't reach for the
	// cmd-level helper here because the happy path always renders the
	// full set; the per-service `--service` filter is a leaf-only knob.
	for _, svc := range renderableServices {
		tplPath := svc.Dir + "/wrangler.local.template.jsonc"
		outPath := svc.Dir + "/wrangler.local.jsonc"
		tpl, err := os.ReadFile(tplPath)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Fprintf(o.errw, "[render] %s: no template (skipping)\n", svc.Name)
				continue
			}
			return err
		}
		rendered, err := wranglercfg.Render(tpl, in)
		if err != nil {
			return fmt.Errorf("render %s: %w", svc.Name, err)
		}
		if err := atomicWrite(outPath, rendered, 0o644); err != nil {
			return err
		}
		fmt.Fprintf(o.errw, "[render] %s → %s\n", svc.Name, outPath)
	}
	return nil
}

func phaseMigrate(ctx context.Context, o happyPathOpts, store *state.Store) error {
	res, err := migrate.Apply(ctx, "polaris-email", true, store)
	if err != nil {
		return err
	}
	if res.Applied == 0 {
		fmt.Fprintln(o.out, "migrate: schema already current")
	} else {
		fmt.Fprintf(o.out, "migrate: applied %d migration(s); latest=%s\n", res.Applied, res.Latest)
	}
	return nil
}

func phaseSecrets(ctx context.Context, o happyPathOpts, _ *state.Store, generatedOut map[string]string) error {
	cfg, _ := config.LoadOrDefault(o.envFile)
	overrides := map[string]string{}
	if cfg != nil {
		for k, v := range cfg.AsMap() {
			if v != "" {
				overrides[k] = v
			}
		}
	}
	srcs := []sources.Source{sources.NewEnvSource(overrides)}
	workers := deploy.Names()
	specs := secrets.DefaultSpecs(workers)
	rec := secrets.NewRecorder(secrets.DefaultRecordPath)
	rep := newSecretsPlainReporter(o.out)
	// Opt-in Secrets Store: when POLARIS_SECRETS_STORE_ID is set (either
	// in env or .env.deploy), Shared specs collapse to a single store
	// push. Otherwise the per-Worker path is used unchanged.
	storeID := overrides["POLARIS_SECRETS_STORE_ID"]
	if storeID == "" {
		storeID = os.Getenv("POLARIS_SECRETS_STORE_ID")
	}
	var storePusher secrets.StorePusher
	if storeID != "" {
		storePusher = secrets.WranglerSecretsStorePusher{StoreID: storeID}
	}
	generated, err := secrets.SeedWithStore(
		ctx, specs, srcs, secrets.WranglerPusher{}, storePusher, rec, rep,
	)
	if err != nil {
		return err
	}
	// Stash any newly-generated values into the in-memory map so the
	// genesis-seal phase can pick POLARIS_SECRET_A up without disk
	// I/O.
	for k, v := range generated {
		generatedOut[k] = v
	}
	// .env.deploy may already carry POLARIS_SECRET_A (re-runs); pick
	// it up from there too if the generator didn't fire.
	if _, ok := generatedOut["POLARIS_SECRET_A"]; !ok {
		if v := overrides["POLARIS_SECRET_A"]; v != "" {
			generatedOut["POLARIS_SECRET_A"] = v
		}
	}
	return nil
}

func phaseDeploy(ctx context.Context, o happyPathOpts, store *state.Store) error {
	rep := deploy.NewPlainReporter(o.out)
	return deploy.Deploy(ctx, deploy.Services, store, deploy.Options{
		NoBuild:  false,
		Force:    false,
		Reporter: rep,
	})
}

func phaseGenesisSeal(ctx context.Context, o happyPathOpts, _ *state.Store, seeded map[string]string) error {
	cfg, _ := config.LoadOrDefault(o.envFile)
	baseURL := resolveAPIBaseURL(cfg)
	if baseURL == "" {
		return errors.New("genesis-seal: no API base URL (set POLARIS_API_HOSTNAME)")
	}
	masterSecret := seeded["POLARIS_SECRET_A"]
	if masterSecret == "" {
		masterSecret = os.Getenv("POLARIS_SECRET_A")
	}
	if masterSecret == "" {
		return errors.New("genesis-seal: POLARIS_SECRET_A not available in-memory; run the secrets phase first")
	}
	opts := genesis.SealOptions{
		APIBaseURL:    baseURL,
		MasterSecret:  masterSecret,
		WebAuthnToken: o.webauthnToken,
		NoBrowser:     o.noBrowser || o.nonInteractive,
		Out:           o.out,
	}
	result, err := genesis.Seal(ctx, opts)
	if err != nil {
		if genesis.IsAlreadyBootstrapped(err) {
			fmt.Fprintln(o.out, "genesis-seal: already bootstrapped — skipping")
			return nil
		}
		return err
	}
	fmt.Fprintf(o.out, "genesis-seal: admin_key_id=%s webauthn_enrolled=%t\n",
		result.AdminKeyID, result.WebAuthnEnrolled)
	return nil
}

func phaseSmoke(ctx context.Context, o happyPathOpts) error {
	cfg, _ := config.LoadOrDefault(o.envFile)
	baseURL := resolveAPIBaseURL(cfg)
	if baseURL == "" {
		return errors.New("smoke: no API base URL")
	}
	scfg := smoke.Config{
		APIBaseURL:    baseURL,
		SyntheticFrom: cfg.SyntheticFrom,
		SyntheticTo:   cfg.SyntheticTo,
		SkipSynthetic: false,
		PollInterval:  5 * time.Second,
		PollTimeout:   60 * time.Second,
	}
	cli, _ := loadAdminClient(baseURL, genesis.DefaultBootstrapOutputPath)
	scfg.APIClient = cli
	results := smoke.RunAll(ctx, scfg)
	for _, r := range results {
		fmt.Fprintf(o.out, "  %s — %s (%s) %s\n", r.Name, r.Status, r.Duration.Round(time.Millisecond), r.Detail)
	}
	if smoke.AnyFailed(results) {
		return errors.New("smoke: one or more checks failed")
	}
	return nil
}

// --- phase helpers ---------------------------------------------------

func isKnownPhase(name string) bool {
	for _, p := range happyPathPhases {
		if p == name {
			return true
		}
	}
	return false
}

func phaseAlreadyComplete(store *state.Store, name string) bool {
	doc, err := store.Read()
	if err != nil || doc == nil || doc.Phases == nil {
		return false
	}
	ph, ok := doc.Phases[name]
	return ok && !ph.CompletedAt.IsZero()
}

func stampPhase(store *state.Store, name string) error {
	doc, err := store.Read()
	if err != nil {
		return err
	}
	if doc.Phases == nil {
		doc.Phases = map[string]state.Phase{}
	}
	doc.Phases[name] = state.Phase{CompletedAt: time.Now().UTC()}
	return store.Write(doc)
}

// HappyPathPhases returns the canonical phase list. Exported for tests
// (and future panel introspection) so we don't fork the constant.
func HappyPathPhases() []string {
	out := make([]string, len(happyPathPhases))
	copy(out, happyPathPhases)
	sort.SliceStable(out, func(i, j int) bool { return phaseIndex(out[i]) < phaseIndex(out[j]) })
	return out
}

func phaseIndex(name string) int {
	for i, p := range happyPathPhases {
		if p == name {
			return i
		}
	}
	return len(happyPathPhases)
}
