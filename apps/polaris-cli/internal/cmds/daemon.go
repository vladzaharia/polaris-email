package cmds

import (
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/wizards"
)

func newDaemonCmd() *cobra.Command {
	c := &cobra.Command{Use: "daemon", Short: "Manage submission daemons"}
	c.AddCommand(daemonListCmd(), daemonRegisterCmd(), daemonShowCmd(), daemonRotateCmd(), daemonDeregisterCmd())
	return c
}

func daemonListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List registered daemons + last_seen",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out []client.Daemon
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/daemons", nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{"NAME", "ENV", "LAST_SEEN", "DISABLED"}}
			for _, d := range out {
				ls := "-"
				if d.LastSeenAt != nil {
					ls = d.LastSeenAt.Format(time.RFC3339)
				}
				dis := "no"
				if d.DisabledAt != nil {
					dis = "yes"
				}
				t.Rows = append(t.Rows, []string{d.Name, d.Environment, ls, dis})
			}
			return EmitTable(t, out)
		},
	}
}

func daemonRegisterCmd() *cobra.Command {
	var fromFile, env, form, writeFile string
	c := &cobra.Command{
		Use:   "register [name]",
		Short: "Mint HMAC key + Cloudflare Access token for a new daemon, output install snippet",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var in *wizards.DaemonRegisterInput
			if fromFile != "" {
				in, err = wizards.LoadDaemonRegisterFile(fromFile)
				if err != nil {
					return err
				}
			} else {
				seed := &wizards.DaemonRegisterInput{Environment: env, OutputForm: form, WriteFile: writeFile}
				if len(args) == 1 {
					seed.Name = args[0]
				}
				if cl.DryRun || seed.Name != "" {
					if err := seed.Validate(); err != nil {
						return err
					}
					in = seed
				} else {
					in, err = wizards.PromptDaemonRegister(seed)
					if err != nil {
						return err
					}
				}
			}
			r, err := wizards.RunDaemonRegister(CtxBackground(), cl, in, Out)
			if err != nil {
				return err
			}
			if r != nil {
				fmt.Fprintln(Errw, "==> store these credentials NOW; they will not be shown again.")
			}
			return nil
		},
	}
	c.Flags().StringVar(&fromFile, "from-file", "", "non-interactive YAML/JSON input")
	c.Flags().StringVar(&env, "environment", "prod", "environment label")
	c.Flags().StringVar(&form, "form", "compose", "install snippet form: compose|systemd")
	c.Flags().StringVar(&writeFile, "write", "", "also write registration.json to this path (mode 0600)")
	return c
}

func daemonShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <name>",
		Short: "Show one daemon",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{"name": []string{args[0]}}
			var out client.Daemon
			if err := cl.DoJSON(CtxBackground(), "GET", "/v1/admin/daemons/lookup", q, nil, &out); err != nil {
				return err
			}
			return Emit(out)
		},
	}
}

func daemonRotateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate <name>",
		Short: "Rotate this daemon's HMAC key + Access token",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/daemons/%s/rotate", url.PathEscape(args[0]))
			var out client.DaemonRegisterResponse
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, nil, &out); err != nil {
				return err
			}
			fmt.Fprintln(Errw, "==> store the rotated credentials NOW; they will not be shown again.")
			return Emit(out)
		},
	}
}

func daemonDeregisterCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "deregister <name>",
		Short: "Deregister a daemon and revoke its credentials",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			path := fmt.Sprintf("/v1/admin/daemons/%s", url.PathEscape(args[0]))
			if err := cl.DoJSON(CtxBackground(), "DELETE", path, nil, nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(Out, "ok")
			return nil
		},
	}
}
