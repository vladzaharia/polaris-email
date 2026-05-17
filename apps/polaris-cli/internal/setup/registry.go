package setup

import (
	"fmt"
	"sort"
	"sync"
)

// registry holds every Daemon registered via init() at package import
// time. The cobra generator in internal/setup/cmd/ enumerates Names()
// to build one subtree per daemon.
//
// Registration happens during package init, which is single-threaded —
// the mutex is defensive against future programmatic registrations
// (e.g. test fixtures spawning daemons mid-run).
var (
	registryMu sync.RWMutex
	registry   = map[string]Daemon{}
)

// Register adds d to the registry. Panics if a daemon with the same
// Name() is already registered — collisions are a build-time bug, not
// a runtime concern.
func Register(d Daemon) {
	if d == nil {
		panic("setup: Register(nil)")
	}
	name := d.Name()
	if name == "" {
		panic("setup: Daemon.Name() returned empty string")
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, exists := registry[name]; exists {
		panic(fmt.Sprintf("setup: daemon %q already registered", name))
	}
	registry[name] = d
}

// Get looks up a registered daemon by Name(). Returns false when no
// daemon under that name exists.
func Get(name string) (Daemon, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	d, ok := registry[name]
	return d, ok
}

// Names returns the sorted list of registered daemon names. The cobra
// generator iterates this slice in deterministic order so the parent
// `setup --help` output is stable.
func Names() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]string, 0, len(registry))
	for name := range registry {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// unregisterForTest removes a daemon from the registry. Test-only helper
// used by the package's interface-contract tests to keep test fixtures
// from leaking into production-side registrations. Not exported; tests
// reach it via the same-package test file.
func unregisterForTest(name string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	delete(registry, name)
}
