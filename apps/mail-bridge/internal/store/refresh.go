package store

import (
	"context"
	"log"
	"time"

	polarissdk "github.com/polaris-mail/polaris-sdk-go"
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
		if err := r.RefreshMailbox(ctx, mb); err != nil {
			log.Printf("mirror: refresh(%s): %v", mb, err)
		}
	}
}

// RefreshMailbox pulls the latest delta for a single mailbox and merges it
// into the mirror. Safe to call from the webhook handler (low-latency
// reactive refresh) and from the periodic tick (baseline safety net).
//
// Errors are returned so the caller can decide how to react; transient
// failures should be logged but not abort whatever surrounding flow is
// happening (e.g. webhook still 204s, baseline tick moves on to next mb).
func (r *Refresher) RefreshMailbox(ctx context.Context, mailboxID string) error {
	last, err := r.Mirror.LastState(ctx, mailboxID)
	if err != nil {
		return err
	}
	ch, err := r.Client.GetMailboxChanges(ctx, mailboxID, last)
	if err != nil {
		return err
	}
	return r.Mirror.ApplyChanges(ctx, mailboxID, Changes{
		Added:   ch.Added,
		Updated: ch.Updated,
		Deleted: ch.Deleted,
		State:   ch.State,
	})
}
