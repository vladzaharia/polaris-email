// Top-level Bubble Tea program orchestrating the 8 tabs.
package app

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/lrstanley/bubblezone"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/datasource"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/polling"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs"
	auditTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/audit"
	bridgesTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/bridges"
	credsTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/credentials"
	dashboardTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/dashboard"
	domainsTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/domains"
	logsTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/logs"
	mailboxesTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/mailboxes"
	webhooksTab "github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/tabs/webhooks"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/tui/theme"
)

// Identity is display-only metadata about who's running the TUI (set by
// the local Cobra command from the credstore profile; or by the Wish
// handler from the resolved operator row).
type Identity struct {
	OperatorID string
	Email      string
}

// Model is the root tea.Model.
type Model struct {
	keymap    Keymap
	theme     *theme.Theme
	zones     *zone.Manager
	identity  Identity
	poller    *polling.Poller
	tabs      []tabs.Tab
	active    int
	width     int
	height    int
	toast     *ToastMsg
	toastID   int
}

// ProgramOpts configures the embedded program.
type ProgramOpts struct {
	Ctx       context.Context
	Client    *client.Client
	Identity  Identity
	Theme     string
	In        io.Reader
	Out       io.Writer
	AltScreen bool
	Extra     []tea.ProgramOption
}

// NewProgram constructs a *tea.Program ready to Run(). I/O is injected so
// the same factory works under Wish (ssh.Session) and locally (os.Stdin/Out).
func NewProgram(opts ProgramOpts) *tea.Program {
	th := theme.Resolve(opts.Theme)
	zm := zone.New()
	ds := datasource.New(opts.Client)

	root := New(ds, opts.Client, th, zm, opts.Identity)
	teaOpts := []tea.ProgramOption{
		tea.WithInput(opts.In),
		tea.WithOutput(opts.Out),
		tea.WithContext(opts.Ctx),
		tea.WithMouseCellMotion(),
	}
	if opts.AltScreen {
		teaOpts = append(teaOpts, tea.WithAltScreen())
	}
	teaOpts = append(teaOpts, opts.Extra...)
	return tea.NewProgram(root, teaOpts...)
}

// New constructs the root Model (without an attached tea.Program).
func New(ds datasource.Datasource, cli *client.Client, th *theme.Theme, zm *zone.Manager, ident Identity) *Model {
	m := &Model{
		keymap:   DefaultKeymap(),
		theme:    th,
		zones:    zm,
		identity: ident,
		poller:   polling.NewPoller(),
	}
	m.tabs = []tabs.Tab{
		dashboardTab.New(ds, th),
		mailboxesTab.New(ds, th),
		domainsTab.New(ds, th),
		credsTab.New(ds, th),
		webhooksTab.New(ds, th),
		bridgesTab.New(ds, th),
		auditTab.New(ds, th),
		logsTab.New(cli, th),
	}
	return m
}

// Init focuses the first tab.
func (m *Model) Init() tea.Cmd {
	return m.tabs[m.active].Focus(m.poller)
}

// Update routes messages.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch x := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = x.Width, x.Height
		m.resizeActiveTab()
		return m, nil
	case tea.MouseMsg:
		if x.Action == tea.MouseActionPress && x.Button == tea.MouseButtonLeft {
			for i := range m.tabs {
				zoneID := fmt.Sprintf("tab-%d", i)
				if z := m.zones.Get(zoneID); z != nil && z.InBounds(x) {
					if i != m.active {
						return m, m.switchTo(i)
					}
				}
			}
		}
	case tea.KeyMsg:
		switch {
		case key.Matches(x, m.keymap.Quit):
			return m, tea.Quit
		case key.Matches(x, m.keymap.NextTab):
			return m, m.switchTo((m.active + 1) % len(m.tabs))
		case key.Matches(x, m.keymap.PrevTab):
			return m, m.switchTo((m.active - 1 + len(m.tabs)) % len(m.tabs))
		case key.Matches(x, m.keymap.Refresh):
			cmds := m.poller.ForceTab(m.tabs[m.active].ID())
			cmds = append(cmds, m.tabs[m.active].Refresh())
			return m, tea.Batch(cmds...)
		case x.String() == "1":
			return m, m.switchTo(0)
		case x.String() == "2":
			return m, m.switchTo(1)
		case x.String() == "3":
			return m, m.switchTo(2)
		case x.String() == "4":
			return m, m.switchTo(3)
		case x.String() == "5":
			return m, m.switchTo(4)
		case x.String() == "6":
			return m, m.switchTo(5)
		case x.String() == "7":
			return m, m.switchTo(6)
		case x.String() == "8":
			return m, m.switchTo(7)
		}
	case ToastMsg:
		t := x
		m.toast = &t
		m.toastID++
		id := m.toastID
		return m, tea.Tick(3*time.Second, func(_ time.Time) tea.Msg {
			return ToastExpireMsg{ID: id}
		})
	case ToastExpireMsg:
		if m.toast != nil && x.ID == m.toastID {
			m.toast = nil
		}
		return m, nil
	case polling.TickMsg, polling.ResultMsg:
		cmd := m.poller.Update(msg)
		// Forward result to active tab so it can update its caches.
		if r, ok := msg.(polling.ResultMsg); ok {
			child, ccmd := m.tabs[m.active].Update(r.Msg)
			if t, ok := child.(tabs.Tab); ok {
				m.tabs[m.active] = t
			}
			return m, tea.Batch(cmd, ccmd)
		}
		return m, cmd
	}
	// Default: forward to the active tab.
	child, ccmd := m.tabs[m.active].Update(msg)
	if t, ok := child.(tabs.Tab); ok {
		m.tabs[m.active] = t
	}
	return m, ccmd
}

// View renders chrome + active tab + status bar.
func (m *Model) View() string {
	if m.width == 0 {
		return ""
	}
	tabBar := m.renderTabBar()
	body := m.tabs[m.active].View()
	status := m.renderStatus()
	out := lipgloss.JoinVertical(lipgloss.Left, tabBar, body, status)
	return m.zones.Scan(out)
}

func (m *Model) renderTabBar() string {
	cells := make([]string, len(m.tabs))
	for i, t := range m.tabs {
		label := fmt.Sprintf(" %s %s ", t.ShortKey(), t.Title())
		style := m.theme.Tab
		if i == m.active {
			style = m.theme.TabActive
		}
		cells[i] = m.zones.Mark(fmt.Sprintf("tab-%d", i), style.Render(label))
	}
	bar := strings.Join(cells, m.theme.Muted.Render("│"))
	return m.theme.TabBarBg.Width(m.width).Render(bar)
}

func (m *Model) renderStatus() string {
	left := m.theme.StatusKey.Render(m.tabs[m.active].Title()) +
		m.theme.Muted.Render("  •  ") +
		m.theme.StatusHint.Render(m.hintLine())
	right := ""
	if m.identity.Email != "" {
		right = m.theme.Muted.Render(m.identity.Email)
	}
	if m.toast != nil {
		var color lipgloss.Style
		switch m.toast.Kind {
		case "error":
			color = m.theme.Danger
		case "warn":
			color = m.theme.Warn
		default:
			color = m.theme.Info
		}
		left += "  " + color.Render(m.toast.Text)
	}
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if gap < 0 {
		gap = 0
	}
	body := left + strings.Repeat(" ", gap) + right
	return m.theme.StatusBar.Width(m.width).Render(body)
}

func (m *Model) hintLine() string {
	return "q quit  ·  tab cycle  ·  1-8 jump  ·  r refresh  ·  ? help"
}

func (m *Model) switchTo(i int) tea.Cmd {
	if i < 0 || i >= len(m.tabs) || i == m.active {
		return nil
	}
	prev := m.active
	m.active = i
	m.resizeActiveTab()
	return tea.Batch(
		m.tabs[prev].Blur(m.poller),
		m.tabs[i].Focus(m.poller),
	)
}

func (m *Model) resizeActiveTab() {
	// Body height: total - tab bar (1) - status bar (1)
	body := m.height - 2
	if body < 5 {
		body = 5
	}
	for _, t := range m.tabs {
		t.Resize(m.width, body)
	}
}
