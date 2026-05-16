package cmds

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newBootstrapCmd() *cobra.Command {
	var webauthn, env string
	c := &cobra.Command{
		Use:   "bootstrap",
		Short: "One-time control-plane setup (genesis audit entry + WebAuthn enrolment)",
		RunE: func(_ *cobra.Command, _ []string) error {
			// `--env` selects the named profile in the config file. This is
			// equivalent to the global `--profile` flag but reads more
			// naturally for a one-shot bootstrap command (matches the
			// docs/operator.md "polaris-email bootstrap --env prod" example).
			if env != "" {
				G.Profile = env
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if webauthn != "" {
				body["webauthn_token"] = webauthn
			}
			if env != "" {
				body["environment"] = env
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
	c.Flags().StringVar(&env, "env", "", "environment / profile name (e.g. prod|staging|dev); aliased onto --profile")
	return c
}
