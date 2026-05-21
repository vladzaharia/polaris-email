package cmds

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

// cf-zone glyphs. Plain ASCII so we never break a non-UTF8 terminal; the
// panel uses richer pills.
const (
	glyphOK   = "✓"
	glyphWarn = "⚠"
	glyphErr  = "✗"
)

func newCFZoneCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "cf-zone",
		Short: "Discover + configure Cloudflare zones (Email Routing, sender domains, catch-all, D1 row)",
		Long: "Operate against the live Cloudflare account: list every zone with its " +
			"polaris-mail readiness, drill into a single zone, and (dry-run by default) " +
			"reconcile drift via the auto-publish endpoints.",
	}
	c.AddCommand(cfZoneListCmd(), cfZoneStatusCmd(), cfZoneConfigureCmd())
	return c
}

// ---------------- list ----------------

func cfZoneListCmd() *cobra.Command {
	var refresh bool
	c := &cobra.Command{
		Use:   "list",
		Short: "List every CF zone in this account with polaris-mail readiness",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			return runCFZoneList(CtxBackground(), cl, refresh)
		},
	}
	c.Flags().BoolVar(&refresh, "refresh", false, "bypass the 60s server-side listing cache")
	return c
}

func runCFZoneList(ctx context.Context, cl *client.Client, refresh bool) error {
	resp, err := cl.ListCFZones(ctx, refresh)
	if err != nil {
		return err
	}
	if resp == nil {
		return nil
	}
	t := &output.Table{Headers: []string{"NAME", "OVERALL", "ROUTING", "DNS", "SENDER", "CATCH-ALL", "RULES", "D1"}}
	for _, z := range resp.Data {
		t.Rows = append(t.Rows, []string{
			z.Zone.Name,
			overallGlyph(z.Overall),
			boolGlyph(z.RoutingEnabled && z.RoutingStatusOK),
			boolGlyph(z.DNSRecordsLocked && len(z.DNSRecordErrors) == 0),
			boolGlyph(z.SenderOnboarded),
			boolGlyph(z.CatchAllCorrect),
			rulesGlyph(z),
			boolGlyph(z.D1MailDomainExists),
		})
	}
	return EmitTable(t, resp)
}

// ---------------- status ----------------

func cfZoneStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <name>",
		Short: "Per-zone detail across all six readiness checks",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			return runCFZoneStatus(CtxBackground(), cl, args[0])
		},
	}
}

func runCFZoneStatus(ctx context.Context, cl *client.Client, name string) error {
	z, err := cl.GetCFZone(ctx, name)
	if err != nil {
		return err
	}
	if z == nil {
		return nil
	}
	if Format() != output.FormatTable {
		return Emit(z)
	}
	renderCFZoneStatus(Out, z)
	return nil
}

func renderCFZoneStatus(w io.Writer, z *client.ZoneDomainStatus) {
	fmt.Fprintf(w, "Zone: %s  (cf-id %s)\n", z.Zone.Name, z.Zone.ID)
	fmt.Fprintf(w, "Overall: %s\n", overallGlyph(z.Overall))
	if z.Error != nil && *z.Error != "" {
		fmt.Fprintf(w, "  %s discovery error: %s\n", glyphErr, *z.Error)
	}
	fmt.Fprintln(w)

	fmt.Fprintf(w, "  %s Email Routing: enabled=%s status=%s\n",
		boolGlyph(z.RoutingEnabled && z.RoutingStatusOK),
		yesNo(z.RoutingEnabled),
		stringOr(z.RoutingStatus, "-"),
	)

	fmt.Fprintf(w, "  %s DNS records locked by CF: %s\n",
		boolGlyph(z.DNSRecordsLocked && len(z.DNSRecordErrors) == 0),
		yesNo(z.DNSRecordsLocked),
	)
	for _, e := range z.DNSRecordErrors {
		fmt.Fprintf(w, "      - %s\n", e)
	}

	fmt.Fprintf(w, "  %s Sender domain onboarded: %s\n",
		boolGlyph(z.SenderOnboarded),
		yesNo(z.SenderOnboarded),
	)
	for _, m := range z.SenderMissingRecords {
		fmt.Fprintf(w, "      missing: %s\n", m)
	}

	target := "<unset>"
	if z.CatchAllTarget != nil {
		target = *z.CatchAllTarget
	}
	fmt.Fprintf(w, "  %s Catch-all rule: target=%s correct=%s\n",
		boolGlyph(z.CatchAllCorrect),
		target,
		yesNo(z.CatchAllCorrect),
	)

	fmt.Fprintf(w, "  %s Named rules: %d total, conflicting=%s\n",
		rulesGlyph(*z),
		len(z.NamedRules),
		yesNo(z.HasConflictingRules),
	)
	for _, r := range z.NamedRules {
		marker := glyphOK
		if !r.RoutesToPolaris {
			marker = glyphWarn
		}
		fmt.Fprintf(w, "      %s %s -> %s (%s) enabled=%s\n",
			marker,
			stringOr(r.AddressPattern, r.Name),
			stringOr(r.ActionTarget, "-"),
			stringOr(r.ActionType, "-"),
			yesNo(r.Enabled),
		)
	}

	fmt.Fprintf(w, "  %s D1 mail_domains row present: %s\n",
		boolGlyph(z.D1MailDomainExists),
		yesNo(z.D1MailDomainExists),
	)
}

// ---------------- configure ----------------

func cfZoneConfigureCmd() *cobra.Command {
	var apply bool
	var opsCSV string
	c := &cobra.Command{
		Use:   "configure <name>",
		Short: "Plan (default) or apply (--apply) the configure diff for a CF zone",
		Long: "Without --apply, posts dry_run=true and prints the planned ops + warnings.\n" +
			"With --apply, posts dry_run=false and prints the applied/failed lists; exits\n" +
			"non-zero if any op failed. Use --ops kind1,kind2 to restrict the action set.",
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			return runCFZoneConfigure(CtxBackground(), cl, args[0], apply, splitCSV(opsCSV))
		},
	}
	c.Flags().BoolVar(&apply, "apply", false, "actually configure the zone (default is dry-run)")
	c.Flags().StringVar(&opsCSV, "ops", "", "comma-separated op kinds to restrict to (default: all planned ops)")
	return c
}

func runCFZoneConfigure(ctx context.Context, cl *client.Client, name string, apply bool, opKinds []string) error {
	res, err := cl.ConfigureCFZone(ctx, name, !apply, opKinds)
	if err != nil {
		return err
	}
	if res == nil {
		return nil
	}
	if Format() != output.FormatTable {
		// JSON / YAML callers want the raw envelope.
		if err := Emit(res); err != nil {
			return err
		}
	} else {
		renderConfigureDiff(Out, res)
	}

	// Exit non-zero on any failed op when applying so CI scripts notice.
	if !res.DryRun && res.Result != nil && !res.Result.AllSucceeded {
		return fmt.Errorf("cf-zone configure: %d op(s) failed", len(res.Result.Failed))
	}
	return nil
}

func renderConfigureDiff(w io.Writer, res *client.ZoneConfigureResult) {
	fmt.Fprintf(w, "Zone: %s\n", res.Diff.Zone.Name)
	if len(res.Diff.Ops) == 0 {
		fmt.Fprintln(w, "Diff: (no changes — zone is already configured)")
	} else {
		fmt.Fprintln(w, "Diff:")
		for _, op := range res.Diff.Ops {
			fmt.Fprintf(w, "  - %s: %s\n", op.Kind, op.Description)
		}
	}
	if len(res.Diff.Warnings) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintln(w, "Warnings:")
		for _, wmsg := range res.Diff.Warnings {
			fmt.Fprintf(w, "  %s %s\n", glyphWarn, wmsg)
		}
	}

	if res.DryRun {
		fmt.Fprintln(w)
		fmt.Fprintln(w, "(dry run — pass --apply to actually configure)")
		return
	}

	// Apply path.
	if res.Result == nil {
		// Server returned no result envelope; treat as best-effort.
		return
	}
	fmt.Fprintln(w)
	if len(res.Result.Applied) > 0 {
		fmt.Fprintln(w, "Applied:")
		for _, op := range res.Result.Applied {
			fmt.Fprintf(w, "  %s %s: %s\n", glyphOK, op.Kind, op.Description)
		}
	}
	if len(res.Result.Failed) > 0 {
		fmt.Fprintln(w, "Failed:")
		for _, f := range res.Result.Failed {
			fmt.Fprintf(w, "  %s %s: %s\n", glyphErr, f.Op.Kind, f.Error)
		}
	}
	if res.Result.AllSucceeded {
		fmt.Fprintln(w, "All ops succeeded.")
	}
}

// ---------------- helpers ----------------

func boolGlyph(ok bool) string {
	if ok {
		return glyphOK
	}
	return glyphErr
}

// rulesGlyph: ✓ when there are no named rules at all OR every named rule
// already routes to polaris (no conflicts); ⚠ when at least one rule routes
// elsewhere; the boolean from HasConflictingRules is authoritative.
func rulesGlyph(z client.ZoneDomainStatus) string {
	if z.HasConflictingRules {
		return glyphWarn
	}
	return glyphOK
}

func overallGlyph(s string) string {
	switch strings.ToLower(s) {
	case "ok":
		return glyphOK + " ok"
	case "warn", "warning":
		return glyphWarn + " warn"
	case "err", "error":
		return glyphErr + " error"
	default:
		// Unknown overall: pass through verbatim so operators see new states.
		if s == "" {
			return "-"
		}
		return s
	}
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func stringOr(s, dflt string) string {
	if s == "" {
		return dflt
	}
	return s
}

func splitCSV(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
