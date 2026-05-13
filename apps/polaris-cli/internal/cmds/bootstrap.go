package cmds

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newBootstrapCmd() *cobra.Command {
	var webauthn string
	c := &cobra.Command{
		Use:   "bootstrap",
		Short: "One-time control-plane setup (genesis audit entry + WebAuthn enrolment)",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if webauthn != "" {
				body["webauthn_token"] = webauthn
			}
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", "/v1/admin/bootstrap", nil, body, &out); err != nil {
				return err
			}
			fmt.Fprintln(Out, "bootstrap complete; audit genesis recorded")
			return Emit(out)
		},
	}
	c.Flags().StringVar(&webauthn, "webauthn-token", "", "WebAuthn-stamped token (required for first-run)")
	return c
}
