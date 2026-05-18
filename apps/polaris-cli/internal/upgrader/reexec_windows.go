//go:build windows

package upgrader

import (
	"fmt"
	"os"
)

// ReExec on Windows can't replace a running executable. atomicReplace
// writes the new binary to `<dst>.new`; we print an operator notice and
// return without exec'ing. The CLI's PersistentPreRunE will exit with
// a non-zero code so the operator's shell prompt comes back; next
// launch picks up the .new binary (the install path scripts on Windows
// rename `polaris-email.exe.new` → `polaris-email.exe` on startup).
func ReExec(path string) error {
	if path == "" {
		exe, _ := os.Executable()
		path = exe
	}
	fmt.Fprintf(os.Stderr,
		"\nUpgrade staged at %s.new — restart your shell to pick up the new binary.\n",
		path)
	return nil
}
