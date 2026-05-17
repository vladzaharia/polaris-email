// Package deploy is the Go port of phase 6 of bin/bootstrap.sh and the
// full bin/deploy.sh. For each registered service it:
//
//  1. (optional) builds the client bundle via `pnpm --filter <name> run
//     build:client` — panel + docs ship a static site alongside the
//     Worker.
//  2. renders + merges the wrangler config (wrangler.jsonc +
//     wrangler.local.jsonc) into a transient .wrangler.merged.json.
//  3. shells out to `wrangler deploy --config <merged>`.
//  4. parses the "Current Version ID: <uuid>" line and records the
//     deploy into state.Doc.Deploys[<service>].
//
// The --changed mode (see changed.go) uses the workspace's
// packages/*/package.json reverse-dep graph to decide which services to
// redeploy after a code/dep change.
package deploy

// Service is one entry in the canonical deploy list. Path is the
// repo-root-relative directory the wrangler config lives in;
// IsClientBuild flags services whose static bundle is built via pnpm
// before wrangler picks it up via the ASSETS binding.
type Service struct {
	// Name is the short, operator-facing identifier (api, out, ...).
	// Also used as the wrangler --name when no explicit override is
	// supplied via wrangler.jsonc.
	Name string
	// Path is the repo-root-relative directory holding wrangler.jsonc
	// and (optionally) wrangler.local.jsonc.
	Path string
	// IsClientBuild marks services that need a `pnpm --filter <pkg> run
	// build:client` step before deploying. panel and docs ship static
	// bundles via the ASSETS binding; the others do not.
	IsClientBuild bool
}

// Services is the canonical deploy order: tail → api → out → in →
// panel → docs → cli-installer.
//
// Why this order:
//   - tail is referenced as a `tail_consumers` entry from api/in/out/panel,
//     so it must be the first thing deployed (else those four fail at
//     wrangler deploy time with an unresolved service binding).
//   - api hosts cron + fanout, so it has to be alive before out/in/panel.
//   - out + in are the email I/O Workers; they call into api.
//   - panel reads from api over the service binding.
//   - docs is independent but lighter-weight; defer it.
//   - cli-installer is installer scaffolding, deploy last.
//
// Adding a service: append it to this slice AND to the matching list
// in bin/_lib.sh::POLARIS_SERVICES until PR 14 retires the shell.
var Services = []Service{
	{Name: "tail", Path: "services/tail"},
	{Name: "api", Path: "services/api"},
	{Name: "out", Path: "services/out"},
	{Name: "in", Path: "services/in"},
	{Name: "panel", Path: "apps/panel", IsClientBuild: true},
	{Name: "docs", Path: "apps/docs", IsClientBuild: true},
	{Name: "cli-installer", Path: "apps/cli-installer"},
}

// ByName returns the Service with the given short name, or false when
// no such service exists.
func ByName(name string) (Service, bool) {
	for _, s := range Services {
		if s.Name == name {
			return s, true
		}
	}
	return Service{}, false
}

// Names returns the short names in canonical deploy order.
func Names() []string {
	out := make([]string, len(Services))
	for i, s := range Services {
		out[i] = s.Name
	}
	return out
}
