// Package polling — tab-aware Bubble Tea scheduler.
//
// Each tab registers Jobs on Focus and pauses them on Blur. The Poller
// dispatches `TickMsg`s, returns Fetch as tea.Cmd, and coalesces concurrent
// inflight fetches per job.
package polling

import (
	"context"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Job identifies one recurring fetch (e.g. "dash.status").
type JobID string

// Job spec.
type Job struct {
	ID       JobID
	Interval time.Duration
	OwnerTab string
	// Fetch returns a tea.Msg containing the freshly-fetched data (or an
	// error wrapped in a domain-specific message). Called from a tea.Cmd
	// so it MUST be safe to run on a goroutine.
	Fetch func(ctx context.Context) tea.Msg
}

// Messages.
type (
	RegisterMsg struct{ Job Job }
	PauseMsg    struct{ ID JobID }
	ResumeMsg   struct{ ID JobID }
	ForceMsg    struct{ ID JobID }
	TickMsg     struct {
		ID JobID
		T  time.Time
	}
	ResultMsg struct {
		ID        JobID
		Msg       tea.Msg
		Err       error
		ElapsedMS int
	}
)

type jobState struct {
	Job
	paused     bool
	inflight   bool
	consecFail int
	lastError  error
	lastOK     time.Time
	nextDelay  time.Duration
}

// Poller is the scheduler. One instance per AppModel.
type Poller struct {
	jobs   map[JobID]*jobState
	maxDur time.Duration
}

func NewPoller() *Poller {
	return &Poller{jobs: map[JobID]*jobState{}, maxDur: 60 * time.Second}
}

// Update routes our own messages + dispatches Ticks. Returns a tea.Cmd.
// Unknown messages return nil; callers should not forward them back.
func (p *Poller) Update(msg tea.Msg) tea.Cmd {
	switch m := msg.(type) {
	case RegisterMsg:
		js, ok := p.jobs[m.Job.ID]
		if !ok {
			js = &jobState{Job: m.Job, nextDelay: m.Job.Interval}
			p.jobs[m.Job.ID] = js
		} else {
			js.Job = m.Job
			js.paused = false
		}
		return tea.Tick(0, func(t time.Time) tea.Msg { return TickMsg{ID: m.Job.ID, T: t} })
	case PauseMsg:
		if js, ok := p.jobs[m.ID]; ok {
			js.paused = true
		}
		return nil
	case ResumeMsg:
		if js, ok := p.jobs[m.ID]; ok {
			js.paused = false
			return tea.Tick(0, func(t time.Time) tea.Msg { return TickMsg{ID: m.ID, T: t} })
		}
		return nil
	case ForceMsg:
		if js, ok := p.jobs[m.ID]; ok {
			return p.runFetch(js)
		}
		return nil
	case TickMsg:
		js, ok := p.jobs[m.ID]
		if !ok {
			return nil
		}
		if js.paused {
			return p.rearm(js)
		}
		if js.inflight {
			return p.rearm(js)
		}
		return p.runFetch(js)
	case ResultMsg:
		js, ok := p.jobs[m.ID]
		if !ok {
			return nil
		}
		js.inflight = false
		if m.Err != nil {
			js.consecFail++
			js.lastError = m.Err
			delay := js.Interval << js.consecFail
			if delay > p.maxDur {
				delay = p.maxDur
			}
			js.nextDelay = delay
		} else {
			js.consecFail = 0
			js.lastError = nil
			js.lastOK = time.Now()
			js.nextDelay = js.Interval
		}
		return p.rearm(js)
	}
	return nil
}

// ForceTab forces an immediate re-fetch of every active job owned by tab.
// Used by the `r` keybinding.
func (p *Poller) ForceTab(tab string) []tea.Cmd {
	var cmds []tea.Cmd
	for _, js := range p.jobs {
		if js.OwnerTab == tab && !js.paused {
			cmds = append(cmds, p.runFetch(js))
		}
	}
	return cmds
}

// JobState returns observability info for the footer.
type JobInfo struct {
	ID        JobID
	OwnerTab  string
	LastOK    time.Time
	LastError error
	Inflight  bool
	Paused    bool
}

func (p *Poller) Snapshot() []JobInfo {
	out := make([]JobInfo, 0, len(p.jobs))
	for _, js := range p.jobs {
		out = append(out, JobInfo{
			ID: js.ID, OwnerTab: js.OwnerTab,
			LastOK: js.lastOK, LastError: js.lastError,
			Inflight: js.inflight, Paused: js.paused,
		})
	}
	return out
}

func (p *Poller) runFetch(js *jobState) tea.Cmd {
	js.inflight = true
	id := js.ID
	fn := js.Fetch
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		start := time.Now()
		msg := fn(ctx)
		var err error
		if e, ok := msg.(error); ok {
			err = e
		}
		return ResultMsg{ID: id, Msg: msg, Err: err, ElapsedMS: int(time.Since(start).Milliseconds())}
	}
}

func (p *Poller) rearm(js *jobState) tea.Cmd {
	id := js.ID
	d := js.nextDelay
	if d == 0 {
		d = js.Interval
	}
	if d <= 0 {
		return nil
	}
	return tea.Tick(d, func(t time.Time) tea.Msg { return TickMsg{ID: id, T: t} })
}
