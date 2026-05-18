// W1 — `polaris-email suppress` CLI subtree.
//
// Mirrors the admin REST surface in services/api/src/routes/admin/suppressions.ts:
//
//   polaris-email suppress list   [--entity recipient|sender] [--reason ...] [--severity ...]
//   polaris-email suppress check  <address>
//   polaris-email suppress add    --entity recipient|sender --address <a>
//                                    --reason <r> [--scope ...] [--scope-target ...]
//                                    [--severity ...] [--notes ...]
//   polaris-email suppress show   <id>
//   polaris-email suppress remove <id> [--reason "why"]
//
// Manual add/remove are approval-gated server-side (dual-admin), so the CLI
// surfaces a friendly hint when a 428 comes back.
package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

// Suppression mirrors the SuppressionRow type from packages/schema.
type Suppression struct {
	ID                string    `json:"id"`
	EntityType        string    `json:"entity_type"`
	AddressNormalized string    `json:"address_normalized"`
	AddressLocal      *string   `json:"address_local"`
	AddressDomain     *string   `json:"address_domain"`
	Scope             string    `json:"scope"`
	ScopeTarget       *string   `json:"scope_target"`
	Reason            string    `json:"reason"`
	Source            string    `json:"source"`
	SourceRef         *string   `json:"source_ref"`
	Severity          string    `json:"severity"`
	CreatedAt         time.Time `json:"created_at"`
	ExpiresAt         *string   `json:"expires_at"`
	DisabledAt        *string   `json:"disabled_at"`
	DisabledReason    *string   `json:"disabled_reason"`
	Notes             *string   `json:"notes"`
}

type suppressListResponse struct {
	Data       []Suppression `json:"data"`
	NextCursor *string       `json:"next_cursor"`
}

type suppressCheckResponse struct {
	Address string        `json:"address"`
	Data    []Suppression `json:"data"`
}

func newSuppressCmd() *cobra.Command {
	c := &cobra.Command{Use: "suppress", Short: "Manage the bi-directional suppression list"}
	c.AddCommand(
		suppressListCmd(),
		suppressShowCmd(),
		suppressCheckCmd(),
		suppressAddCmd(),
		suppressRemoveCmd(),
	)
	return c
}

func suppressListCmd() *cobra.Command {
	var entityType, reason, source, severity, scope, address string
	var includeDisabled bool
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List suppressions (filter by entity, reason, source, severity, scope)",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if entityType != "" {
				q.Set("entity_type", entityType)
			}
			if reason != "" {
				q.Set("reason", reason)
			}
			if source != "" {
				q.Set("source", source)
			}
			if severity != "" {
				q.Set("severity", severity)
			}
			if scope != "" {
				q.Set("scope", scope)
			}
			if address != "" {
				q.Set("address", address)
			}
			if includeDisabled {
				q.Set("include_disabled", "1")
			}
			path := "/v1/admin/suppressions"
			if encoded := q.Encode(); encoded != "" {
				path += "?" + encoded
			}
			var out suppressListResponse
			if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{
				"ID", "ENTITY", "ADDRESS", "REASON", "SCOPE", "SEVERITY", "SOURCE", "CREATED", "STATE",
			}}
			for _, s := range out.Data {
				state := "active"
				if s.DisabledAt != nil {
					state = "disabled"
				}
				scopeStr := s.Scope
				if s.ScopeTarget != nil {
					scopeStr += ":" + *s.ScopeTarget
				}
				t.Rows = append(t.Rows, []string{
					s.ID, s.EntityType, s.AddressNormalized, s.Reason, scopeStr,
					s.Severity, s.Source, s.CreatedAt.Format(time.RFC3339), state,
				})
			}
			return EmitTable(t, out.Data)
		},
	}
	cmd.Flags().StringVar(&entityType, "entity", "", "filter by entity_type (recipient|sender)")
	cmd.Flags().StringVar(&reason, "reason", "", "filter by reason")
	cmd.Flags().StringVar(&source, "source", "", "filter by source")
	cmd.Flags().StringVar(&severity, "severity", "", "filter by severity (info|warn|critical)")
	cmd.Flags().StringVar(&scope, "scope", "", "filter by scope (global|domain|mailbox|sender_address)")
	cmd.Flags().StringVar(&address, "address", "", "filter by exact address (normalized server-side)")
	cmd.Flags().BoolVar(&includeDisabled, "include-disabled", false, "include rows whose disabled_at is set")
	return cmd
}

func suppressShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id>",
		Short: "Show a single suppression",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var s Suppression
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/suppressions/"+args[0], nil, nil, &s); err != nil {
				return err
			}
			return Emit(s)
		},
	}
}

func suppressCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check <address>",
		Short: "Return ALL active suppressions matching this address (both recipient + sender)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			q.Set("address", args[0])
			var out suppressCheckResponse
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/suppressions/check?"+q.Encode(), nil, nil, &out); err != nil {
				return err
			}
			if len(out.Data) == 0 {
				fmt.Fprintf(Out, "no active suppressions for %s\n", out.Address)
				return nil
			}
			t := &output.Table{Headers: []string{"ID", "ENTITY", "REASON", "SCOPE", "SEVERITY", "SOURCE", "CREATED"}}
			for _, s := range out.Data {
				scopeStr := s.Scope
				if s.ScopeTarget != nil {
					scopeStr += ":" + *s.ScopeTarget
				}
				t.Rows = append(t.Rows, []string{
					s.ID, s.EntityType, s.Reason, scopeStr, s.Severity, s.Source, s.CreatedAt.Format(time.RFC3339),
				})
			}
			return EmitTable(t, out.Data)
		},
	}
}

func suppressAddCmd() *cobra.Command {
	var entity, address, reason, scope, scopeTarget, severity, notes, expiresAt string
	cmd := &cobra.Command{
		Use:   "add",
		Short: "Manually add a suppression (approval-gated server-side)",
		RunE: func(_ *cobra.Command, _ []string) error {
			if entity == "" || address == "" || reason == "" {
				return fmt.Errorf("--entity, --address, --reason are required")
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			body := map[string]any{
				"entity_type": entity,
				"address":     address,
				"reason":      reason,
				"source":      "cli",
				"scope":       firstNonEmpty(scope, "global"),
				"severity":    firstNonEmpty(severity, "warn"),
			}
			if scopeTarget != "" {
				body["scope_target"] = scopeTarget
			}
			if notes != "" {
				body["notes"] = notes
			}
			if expiresAt != "" {
				body["expires_at"] = expiresAt
			}
			var resp map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/admin/suppressions", nil, body, &resp); err != nil {
				return err
			}
			return Emit(resp)
		},
	}
	cmd.Flags().StringVar(&entity, "entity", "", "recipient|sender (required)")
	cmd.Flags().StringVar(&address, "address", "", "email address (required)")
	cmd.Flags().StringVar(&reason, "reason", "", "see suppressions table CHECK list (required)")
	cmd.Flags().StringVar(&scope, "scope", "global", "global|domain|mailbox|sender_address")
	cmd.Flags().StringVar(&scopeTarget, "scope-target", "", "id when scope != global")
	cmd.Flags().StringVar(&severity, "severity", "warn", "info|warn|critical")
	cmd.Flags().StringVar(&notes, "notes", "", "freeform operator note")
	cmd.Flags().StringVar(&expiresAt, "expires-at", "", "ISO-8601 timestamp; omit for permanent")
	return cmd
}

func suppressRemoveCmd() *cobra.Command {
	var reason string
	cmd := &cobra.Command{
		Use:   "remove <id>",
		Short: "Soft-disable a suppression (approval-gated server-side)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			q.Set("reason", firstNonEmpty(reason, "operator_override"))
			var resp map[string]any
			if err := cl.DoJSON(CtxBackground(), "DELETE", "/v1/admin/suppressions/"+args[0]+"?"+q.Encode(), nil, nil, &resp); err != nil {
				return err
			}
			return Emit(resp)
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "operator_override", "why this row is being disabled")
	return cmd
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
