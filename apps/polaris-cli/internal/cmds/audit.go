package cmds

import (
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

func newAuditCmd() *cobra.Command {
	c := &cobra.Command{Use: "audit", Short: "Audit chain + R2 anchors"}
	c.AddCommand(auditVerifyCmd(), auditAnchorsCmd())
	return c
}

func auditVerifyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "verify",
		Short: "Walk the audit hash chain end-to-end",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out client.AuditChainResult
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/audit/chain", nil, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func auditAnchorsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "anchors",
		Short: "List R2 anchors",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out []client.AuditAnchor
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/audit/anchors", nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"ID", "HASH", "R2_KEY", "CREATED"}}
			for _, a := range out {
				t.Rows = append(t.Rows, []string{a.ID, a.Hash, a.R2Key, a.CreatedAt.Format("2006-01-02 15:04:05")})
			}
			return EmitTable(t, out)
		},
	}
}
