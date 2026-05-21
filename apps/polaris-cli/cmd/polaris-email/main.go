// Command polaris-mail is the operator CLI for the polaris-mail control
// plane. The same binary is symlinked as `pml`.
package main

import (
	"fmt"
	"os"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/cmds"
)

func main() {
	if err := cmds.NewRoot().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
