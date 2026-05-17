// Package tabs declares the contract every TUI tab implements.
package tabs

import (
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
)

// Tab is the per-screen contract. The AppModel forwards Update/View only
// when this tab is active; Focus/Blur control polling subscription.
type Tab interface {
	tea.Model

	ID() string
	Title() string
	ShortKey() string

	Focus(p *polling.Poller) tea.Cmd
	Blur(p *polling.Poller) tea.Cmd

	RefreshInterval() time.Duration
	Refresh() tea.Cmd

	Keybindings() []key.Binding
	Resize(width, height int)
}
