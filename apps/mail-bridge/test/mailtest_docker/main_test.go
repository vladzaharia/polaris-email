//go:build mailtest_docker

package mailtest_docker

import (
	"fmt"
	"os"
	"testing"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

var sharedCA *mt.CA

func TestMain(m *testing.M) {
	ca, err := mt.MintCAStandalone()
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailtest_docker: mint CA: %v\n", err)
		os.Exit(1)
	}
	sharedCA = ca
	os.Exit(m.Run())
}
