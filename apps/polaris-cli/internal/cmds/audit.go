package cmds

import (
	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

func newAuditCmd() *cobra.Command {
	c := &cobra.Command{Use: "audit", Short: "Audit chain inspection + verification"}
	c.AddCommand(auditVerifyCmd())
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
