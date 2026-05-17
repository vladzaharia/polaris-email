// App-level messages routed between tabs and components.
package app

import (
	tea "github.com/charmbracelet/bubbletea"
)

// TabSwitchMsg requests focus change to tab Index.
type TabSwitchMsg struct{ Index int }

// ModalPushMsg adds a modal to the top of the stack.
type ModalPushMsg struct{ Modal tea.Model }

// ModalPopMsg pops the topmost modal.
type ModalPopMsg struct{}

// ToastMsg surfaces a transient banner in the status bar.
type ToastMsg struct {
	Text string
	Kind string // "info" | "warn" | "error"
}

// ToastExpireMsg fires when a toast's TTL elapses; the AppModel removes it.
type ToastExpireMsg struct{ ID int }

// ApiErrMsg is dispatched by tabs when an HTTP call fails.
type ApiErrMsg struct {
	TabID string
	Err   error
}
