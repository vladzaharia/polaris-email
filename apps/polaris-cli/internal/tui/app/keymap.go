// Global key bindings.
package app

import "github.com/charmbracelet/bubbles/key"

type Keymap struct {
	Quit    key.Binding
	NextTab key.Binding
	PrevTab key.Binding
	Refresh key.Binding
	Help    key.Binding
	Escape  key.Binding
	Tab1    key.Binding
	Tab2    key.Binding
	Tab3    key.Binding
	Tab4    key.Binding
	Tab5    key.Binding
	Tab6    key.Binding
	Tab7    key.Binding
	Tab8    key.Binding
}

func DefaultKeymap() Keymap {
	return Keymap{
		Quit:    key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
		NextTab: key.NewBinding(key.WithKeys("tab", "right"), key.WithHelp("tab", "next tab")),
		PrevTab: key.NewBinding(key.WithKeys("shift+tab", "left"), key.WithHelp("S-tab", "prev tab")),
		Refresh: key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "refresh")),
		Help:    key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
		Escape:  key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "back/cancel")),
		Tab1:    key.NewBinding(key.WithKeys("1"), key.WithHelp("1", "Dashboard")),
		Tab2:    key.NewBinding(key.WithKeys("2"), key.WithHelp("2", "Mailboxes")),
		Tab3:    key.NewBinding(key.WithKeys("3"), key.WithHelp("3", "Domains")),
		Tab4:    key.NewBinding(key.WithKeys("4"), key.WithHelp("4", "Credentials")),
		Tab5:    key.NewBinding(key.WithKeys("5"), key.WithHelp("5", "Webhooks/DLQ")),
		Tab6:    key.NewBinding(key.WithKeys("6"), key.WithHelp("6", "Bridges")),
		Tab7:    key.NewBinding(key.WithKeys("7"), key.WithHelp("7", "Audit")),
		Tab8:    key.NewBinding(key.WithKeys("8"), key.WithHelp("8", "Logs")),
	}
}
