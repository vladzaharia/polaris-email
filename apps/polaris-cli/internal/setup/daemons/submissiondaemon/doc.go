// Package submissiondaemon is a skeleton placeholder demonstrating how
// a second container-bootstrap descriptor would slot into the
// internal/setup daemon registry without touching the cobra generator.
//
// The implementation is intentionally empty — PR 10's scope is the
// abstraction, not a working submission-daemon. The plan tracks the
// real implementation as a follow-up.
//
// # How a submission-daemon descriptor would slot in
//
// 1. Concrete files (sibling layout to daemons/bridge/):
//
//   - daemons/submissiondaemon/submissiondaemon.go — `Init`, `Up`,
//     `Down`, `Status`, `Destroy` package-level helpers (compose
//     wrapper), mirrors daemons/bridge/bridge.go.
//   - daemons/submissiondaemon/input.go — `SubmissionDaemonSetupInput`
//     struct + `Validate` / `Defaults` / `LoadInputFile`, mirrors the
//     bridge's input.go. Includes a `Marshal` / `Unmarshal` /
//     `ModeString` adapter trio so the descriptor can wrap it for the
//     setup.Input interface.
//   - daemons/submissiondaemon/descriptor.go — `Descriptor` struct
//     plus methods satisfying setup.Daemon, setup.Lifecycle,
//     setup.Persistable, setup.FlagBinder, setup.FlagApplier,
//     setup.Defaulter, setup.DirDefaulter, setup.InputLoader. The
//     init() at the bottom calls setup.Register(singleton) — that
//     single line is what activates the descriptor at startup.
//   - daemons/submissiondaemon/templates/ — embed.FS rooted compose +
//     env templates. Drawn from apps/submission-daemon/docker-compose
//     .{local,tailnet}.yml once that project lands.
//   - daemons/submissiondaemon/prechecks.go,
//     daemons/submissiondaemon/probes.go,
//     daemons/submissiondaemon/registration.go,
//     daemons/submissiondaemon/render.go — pure ports of the bridge
//     equivalents with submission-daemon-specific protocol details
//     (submission queue REST endpoint instead of SMTPS/IMAP probes,
//     etc.).
//
// 2. Activation — one blank-import line in cmd/setup.go:
//
//	_ "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/daemons/submissiondaemon"
//
// At that point the cobra generator surfaces the new subtree
// automatically:
//
//	polaris-mail setup submission-daemon precheck
//	polaris-mail setup submission-daemon init
//	polaris-mail setup submission-daemon register
//	polaris-mail setup submission-daemon up
//	polaris-mail setup submission-daemon verify
//	polaris-mail setup submission-daemon status
//	polaris-mail setup submission-daemon down
//	polaris-mail setup submission-daemon destroy
//	polaris-mail setup submission-daemon upgrade
//
// No edits to cmd/setup.go beyond the blank-import. No edits to the
// generator. No new flag plumbing — the shared --dir / --from-file /
// --image-tag / --profile flags are inherited from addCommonFlags.
// Per-daemon defaults (default dir, snapshot path) come from the
// descriptor's DirDefaulter / Snapshotter implementations.
//
// 3. Deployment-mode parity — the submission-daemon will ship with
// the same two first-class modes the bridge has today: a tailscale
// sidecar variant and a local/host-network variant. The wizard's
// mode select must mirror the bridge wizard's "no default" rule so
// operators choose explicitly. See CLAUDE.md "Tailscale sidecar is
// optional, not default".
//
// 4. Tests — write golden tests at the same shape as the bridge's
// render_test.go (testdata/render-golden/<scenario>/<file>) so the
// compose templates have an authoritative reference. Validate +
// Defaults coverage mirrors input_test.go.
//
// The whole abstraction is sound iff the steps above are sufficient
// to ship a second daemon without touching the cobra generator. PR 10
// removes setup_bridge.go specifically to prove that.
package submissiondaemon
