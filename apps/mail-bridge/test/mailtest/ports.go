package mailtest

import (
	"fmt"
	"net"
	"testing"
)

// AllocatePorts reserves n unused TCP ports on 127.0.0.1 by binding,
// reading the port, then immediately closing. Race-prone in principle
// (the kernel may hand the same port back to another listener before
// the bridge claims it), but cheap and stable in practice. Callers
// should retry the whole bring-up on bind errors.
func AllocatePorts(t *testing.T, n int) []int {
	t.Helper()
	ports := make([]int, n)
	listeners := make([]net.Listener, n)
	defer func() {
		for _, l := range listeners {
			if l != nil {
				_ = l.Close()
			}
		}
	}()
	for i := range n {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("mailtest: allocate port %d: %v", i, err)
		}
		listeners[i] = l
		ports[i] = l.Addr().(*net.TCPAddr).Port
	}
	return ports
}

// HostPort formats a host:port string. Convenience for the harness's
// SMTPSAddr() etc. accessors.
func HostPort(host string, port int) string {
	return fmt.Sprintf("%s:%d", host, port)
}

// AllocatePortsStandalone is the error-less variant of AllocatePorts
// for use from TestMain (which doesn't have a *testing.T). On any
// allocation error it returns a shorter slice (caller should check
// len(out) == n).
func AllocatePortsStandalone(n int) []int {
	out := make([]int, 0, n)
	listeners := make([]net.Listener, 0, n)
	defer func() {
		for _, l := range listeners {
			_ = l.Close()
		}
	}()
	for range n {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return out
		}
		listeners = append(listeners, l)
		out = append(out, l.Addr().(*net.TCPAddr).Port)
	}
	return out
}
