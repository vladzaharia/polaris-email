package state

import (
	"context"
	"fmt"
	"time"
)

// CFLister is the minimum surface required to rebuild a state document
// from a live Cloudflare account. The implementation lives in cfapi but is
// referenced via this interface so the state package never imports cfapi
// (avoiding a circular dep).
type CFLister interface {
	ListD1Databases(ctx context.Context) ([]CFResource, error)
	ListR2Buckets(ctx context.Context) ([]CFR2Bucket, error)
	ListKVNamespaces(ctx context.Context) ([]CFResource, error)
	ListQueues(ctx context.Context) ([]CFResource, error)
}

// CFResource is the minimum bag of fields a list endpoint returns. It is
// duplicated here (rather than imported from cfapi) so this package stays
// import-free of cfapi.
type CFResource struct {
	ID   string
	Name string
}

// CFR2Bucket carries R2-only fields. The CF list endpoint does not return
// the Object Lock window for a bucket, so we leave that field zero on
// discovery — operators see "object_lock_hours: 0" and know to re-run
// `setup infra` to reassert configuration.
type CFR2Bucket struct {
	Name         string
	Jurisdiction string
	CreatedAt    time.Time
}

// Rebuild fetches a fresh inventory from CF and returns a Doc with every
// resource marked Discovered=true. The caller is responsible for
// persisting the doc with Store.Write — Rebuild itself never touches
// disk.
//
// This is intentionally minimal — PR 5 fleshes out drift detection +
// cross-checking against the previous state. For PR 1 this stub gives the
// `state rebuild` command something to call.
func Rebuild(ctx context.Context, lister CFLister, accountID string) (*Doc, error) {
	if lister == nil {
		return nil, fmt.Errorf("state: Rebuild requires a CFLister")
	}
	now := time.Now().UTC()
	doc := &Doc{
		SchemaVersion: CurrentSchema,
		CreatedAt:     now,
		UpdatedAt:     now,
		AccountID:     accountID,
	}

	d1s, err := lister.ListD1Databases(ctx)
	if err != nil {
		return nil, fmt.Errorf("state: rebuild d1: %w", err)
	}
	if len(d1s) > 0 {
		doc.D1 = make(map[string]Resource, len(d1s))
		for _, r := range d1s {
			doc.D1[r.Name] = Resource{ID: r.ID, Name: r.Name, CreatedAt: now, Discovered: true}
		}
	}

	r2s, err := lister.ListR2Buckets(ctx)
	if err != nil {
		return nil, fmt.Errorf("state: rebuild r2: %w", err)
	}
	if len(r2s) > 0 {
		doc.R2 = make(map[string]R2Bucket, len(r2s))
		for _, b := range r2s {
			created := b.CreatedAt
			if created.IsZero() {
				created = now
			}
			doc.R2[b.Name] = R2Bucket{
				Name:         b.Name,
				Jurisdiction: b.Jurisdiction,
				CreatedAt:    created,
				Discovered:   true,
			}
		}
	}

	kvs, err := lister.ListKVNamespaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("state: rebuild kv: %w", err)
	}
	if len(kvs) > 0 {
		doc.KV = make(map[string]Resource, len(kvs))
		for _, r := range kvs {
			doc.KV[r.Name] = Resource{ID: r.ID, Name: r.Name, CreatedAt: now, Discovered: true}
		}
	}

	queues, err := lister.ListQueues(ctx)
	if err != nil {
		return nil, fmt.Errorf("state: rebuild queues: %w", err)
	}
	if len(queues) > 0 {
		doc.Queues = make(map[string]Resource, len(queues))
		for _, r := range queues {
			doc.Queues[r.Name] = Resource{ID: r.ID, Name: r.Name, CreatedAt: now, Discovered: true}
		}
	}

	return doc, nil
}
