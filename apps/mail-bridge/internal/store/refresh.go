package store

import (
	"context"
	"log"
	"time"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// Refresher pulls mailbox state from polaris on a baseline timer. Reactive
// (webhook-driven) refresh is wired separately in `internal/webhook`; this
// loop is the safety net.
type Refresher struct {
	Mirror   *Mirror
	Client   *polarissdk.Client
	Interval time.Duration
	// Mailboxes is the set of mailbox ids the bridge serves. The bootstrap
	// path populates this from the credentials it loaded.
	Mailboxes []string
}

// Run blocks until ctx is cancelled, ticking once per Interval.
func (r *Refresher) Run(ctx context.Context) {
	iv := r.Interval
	if iv <= 0 {
		iv = 30 * time.Second
	}
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		// Run once immediately on start so first IMAP SELECT after boot has
		// data.
		r.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// tick pulls deltas for each tracked mailbox and merges them.
func (r *Refresher) tick(ctx context.Context) {
	for _, mb := range r.Mailboxes {
		last, err := r.Mirror.LastState(ctx, mb)
		if err != nil {
			log.Printf("mirror: last_state(%s) failed: %v", mb, err)
			continue
		}
		ch, err := r.Client.GetMailboxChanges(ctx, mb, last)
		if err != nil {
			// Soft failure — likely transient network blip.
			log.Printf("mirror: changes(%s, since=%d) failed: %v", mb, last, err)
			continue
		}
		if err := r.Mirror.ApplyChanges(ctx, mb, Changes{
			Updated: ch.Updated,
			Deleted: ch.Deleted,
			State:   ch.State,
		}); err != nil {
			log.Printf("mirror: apply(%s) failed: %v", mb, err)
		}
	}
}

// TODO(production): wire a reactive-refresh entry point that the webhook
// handler invokes when a `message.received` event lands. The current
// `Refresher.tick` covers correctness but not low-latency push.
