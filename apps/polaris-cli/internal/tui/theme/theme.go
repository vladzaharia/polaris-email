// Package theme — semantic lipgloss style sets driven by catppuccin.
package theme

import (
	cp "github.com/catppuccin/go" //nolint:revive // upstream package is `catppuccingo`; alias for readability
	"github.com/charmbracelet/lipgloss"
)

// Theme is the palette every TUI component renders against.
type Theme struct {
	// Chrome.
	Tab           lipgloss.Style
	TabActive     lipgloss.Style
	TabBarBg      lipgloss.Style
	StatusBar     lipgloss.Style
	StatusKey     lipgloss.Style
	StatusHint    lipgloss.Style
	ModalBackdrop lipgloss.Style
	ModalCard     lipgloss.Style
	ModalTitle    lipgloss.Style

	// Tables.
	TableHeader   lipgloss.Style
	TableSelected lipgloss.Style
	TableRow      lipgloss.Style
	TableRowAlt   lipgloss.Style
	Border        lipgloss.Border

	// Semantic.
	OK       lipgloss.Style
	Warn     lipgloss.Style
	Danger   lipgloss.Style
	Muted    lipgloss.Style
	Info     lipgloss.Style
	Title    lipgloss.Style
	Subtitle lipgloss.Style
	Code     lipgloss.Style
}

// Resolve maps a string name to a Theme, defaulting to macchiato.
func Resolve(name string) *Theme {
	switch name {
	case "mocha":
		return fromFlavor(cp.Mocha)
	case "frappe":
		return fromFlavor(cp.Frappe)
	case "latte":
		return fromFlavor(cp.Latte)
	default:
		return fromFlavor(cp.Macchiato)
	}
}

func fromFlavor(f cp.Flavor) *Theme {
	mauve := lipgloss.Color(f.Mauve().Hex)
	green := lipgloss.Color(f.Green().Hex)
	yellow := lipgloss.Color(f.Yellow().Hex)
	red := lipgloss.Color(f.Red().Hex)
	sky := lipgloss.Color(f.Sky().Hex)
	overlay := lipgloss.Color(f.Overlay0().Hex)
	subtext := lipgloss.Color(f.Subtext0().Hex)
	text := lipgloss.Color(f.Text().Hex)
	base := lipgloss.Color(f.Base().Hex)
	surface0 := lipgloss.Color(f.Surface0().Hex)
	surface1 := lipgloss.Color(f.Surface1().Hex)
	crust := lipgloss.Color(f.Crust().Hex)

	return &Theme{
		Tab:           lipgloss.NewStyle().Foreground(subtext).Padding(0, 2),
		TabActive:     lipgloss.NewStyle().Foreground(text).Background(mauve).Bold(true).Padding(0, 2),
		TabBarBg:      lipgloss.NewStyle().Background(crust),
		StatusBar:     lipgloss.NewStyle().Background(surface0).Foreground(subtext).Padding(0, 1),
		StatusKey:     lipgloss.NewStyle().Foreground(mauve).Bold(true),
		StatusHint:    lipgloss.NewStyle().Foreground(overlay),
		ModalBackdrop: lipgloss.NewStyle().Background(base).Foreground(overlay).Faint(true),
		ModalCard: lipgloss.NewStyle().
			Background(surface0).
			Foreground(text).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(mauve).
			Padding(1, 2),
		ModalTitle:    lipgloss.NewStyle().Foreground(mauve).Bold(true),
		TableHeader:   lipgloss.NewStyle().Foreground(mauve).Bold(true).Padding(0, 1),
		TableSelected: lipgloss.NewStyle().Foreground(text).Background(surface1).Bold(true).Padding(0, 1),
		TableRow:      lipgloss.NewStyle().Foreground(text).Padding(0, 1),
		TableRowAlt:   lipgloss.NewStyle().Foreground(subtext).Padding(0, 1),
		Border:        lipgloss.RoundedBorder(),
		OK:            lipgloss.NewStyle().Foreground(green).Bold(true),
		Warn:          lipgloss.NewStyle().Foreground(yellow).Bold(true),
		Danger:        lipgloss.NewStyle().Foreground(red).Bold(true),
		Muted:         lipgloss.NewStyle().Foreground(overlay),
		Info:          lipgloss.NewStyle().Foreground(sky),
		Title:         lipgloss.NewStyle().Foreground(mauve).Bold(true),
		Subtitle:      lipgloss.NewStyle().Foreground(subtext).Italic(true),
		Code:          lipgloss.NewStyle().Foreground(green).Background(surface0),
	}
}
