package mailtest

import (
	"context"
	"sync"
	"time"
)

// WaitForHeartbeat blocks until the next heartbeat from `b` arrives.
// Baseline is the current heartbeat count at call time, so successive
// calls don't re-return the same heartbeat. Returns the zero Heartbeat
// on ctx cancellation / timeout.
func (f *FakeServer) WaitForHeartbeat(ctx context.Context, b Bridge) Heartbeat {
	hbs := f.WaitForNHeartbeats(ctx, b, 1)
	if len(hbs) == 0 {
		return Heartbeat{}
	}
	return hbs[0]
}

// WaitForNHeartbeats accumulates n heartbeats arriving after the call.
// Returns whatever it gathered if ctx fires mid-wait.
func (f *FakeServer) WaitForNHeartbeats(ctx context.Context, b Bridge, n int) []Heartbeat {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return nil
	}
	baseline := br.heartbeatCount
	out := make([]Heartbeat, 0, n)
	deadline := deadlineFromCtx(ctx)
	for len(out) < n {
		current := br.heartbeatCount
		if current > baseline+len(out) {
			// Copy any new heartbeats since we last looked.
			for i := baseline + len(out); i < current && len(out) < n; i++ {
				out = append(out, br.heartbeats[i])
			}
			continue
		}
		if !waitCondWithDeadline(f.state.cond, deadline) {
			return out
		}
	}
	return out
}

// WaitForDirectiveAck blocks until the bridge acks the given directive.
func (f *FakeServer) WaitForDirectiveAck(ctx context.Context, b Bridge, id DirectiveID) DirectiveAck {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return DirectiveAck{}
	}
	deadline := deadlineFromCtx(ctx)
	for {
		if ack, ok := br.acked[string(id)]; ok {
			return ack
		}
		if !waitCondWithDeadline(f.state.cond, deadline) {
			return DirectiveAck{}
		}
	}
}

// WaitForSubmittedMessage blocks until there is at least one
// /v1/messages POST observed, returning the LAST one. Tests that
// trigger the submission BEFORE calling this helper still see it (the
// race-free pattern); tests that need "next after X" semantics should
// snapshot SubmissionsFor() first and use WaitForSubmittedMessageAfter.
func (f *FakeServer) WaitForSubmittedMessage(ctx context.Context, b Bridge) SubmittedMessage {
	return f.WaitForSubmittedMessageAfter(ctx, b, 0)
}

// WaitForSubmittedMessageAfter blocks until len(submissions) >
// baseline, returning submissions[baseline]. Use baseline = 0 to wait
// for the first submission; use baseline = len(SubmissionsFor(b)) to
// wait for the next one after the call.
func (f *FakeServer) WaitForSubmittedMessageAfter(ctx context.Context, b Bridge, baseline int) SubmittedMessage {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return SubmittedMessage{}
	}
	deadline := deadlineFromCtx(ctx)
	for {
		if len(br.submissions) > baseline {
			return br.submissions[baseline]
		}
		if !waitCondWithDeadline(f.state.cond, deadline) {
			return SubmittedMessage{}
		}
	}
}

// LastHeartbeat returns the most recent observed heartbeat, or ok=false
// if there hasn't been one yet.
func (f *FakeServer) LastHeartbeat(b Bridge) (Heartbeat, bool) {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok || len(br.heartbeats) == 0 {
		return Heartbeat{}, false
	}
	return br.heartbeats[len(br.heartbeats)-1], true
}

// WaitForWebhookBootstrap blocks until the bridge has registered a
// webhook subscription and the fake has its secret + URL. Used by
// HarnessOpts.Start() so DeliverWebhook never races the bootstrap.
func (f *FakeServer) WaitForWebhookBootstrap(ctx context.Context, b Bridge) bool {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	br, ok := f.state.bridges[b.ID]
	if !ok {
		return false
	}
	deadline := deadlineFromCtx(ctx)
	for {
		if br.webhookURL != "" && br.webhookSecret != nil {
			return true
		}
		if !waitCondWithDeadline(f.state.cond, deadline) {
			return false
		}
	}
}

// -------- internals --------

func deadlineFromCtx(ctx context.Context) time.Time {
	if d, ok := ctx.Deadline(); ok {
		return d
	}
	return time.Now().Add(30 * time.Second)
}

// waitCondWithDeadline parks on cond until either a Broadcast/Signal
// arrives or the deadline elapses. Returns true if the wait returned
// before the deadline; false if the deadline fired.
//
// sync.Cond doesn't natively support timeouts — we schedule a one-shot
// broadcast at the deadline so the wait wakes up. The caller's loop
// will re-check its predicate; on a real broadcast plus a stale
// deadline-broadcast we'll loop and re-park, which is fine.
func waitCondWithDeadline(cond *sync.Cond, deadline time.Time) bool {
	wait := time.Until(deadline)
	if wait <= 0 {
		return false
	}
	timer := time.AfterFunc(wait, func() {
		cond.L.Lock()
		cond.Broadcast()
		cond.L.Unlock()
	})
	cond.Wait()
	stopped := timer.Stop()
	if !stopped {
		// Timer already fired. Was it because the deadline elapsed, or
		// because a real broadcast came in shortly before the timer? Look
		// at the clock.
		return time.Now().Before(deadline)
	}
	return true
}
