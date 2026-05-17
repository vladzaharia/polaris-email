package preflight

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckB2Anchor_UnconfiguredWarns(t *testing.T) {
	t.Parallel()
	res := CheckB2Anchor(B2Config{}).Run(context.Background())
	if res.Status != StatusWarn {
		t.Errorf("unconfigured B2 should warn, got %+v", res)
	}
}

func TestCheckB2Anchor_ReachableBucket(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("want HEAD, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := CheckB2Anchor(B2Config{Endpoint: srv.URL, Bucket: "polaris-anchors"})
	res := c.Run(context.Background())
	if res.Status != StatusPass {
		t.Errorf("200 should pass, got %+v", res)
	}
}

func TestCheckB2Anchor_UnauthorizedStillPasses(t *testing.T) {
	// B2 returns 401/403 for unauthenticated HEAD on private buckets — we
	// treat that as "reachable, valid name" because preflight isn't
	// SigV4-signed.
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	res := CheckB2Anchor(B2Config{Endpoint: srv.URL, Bucket: "polaris-anchors"}).Run(context.Background())
	if res.Status != StatusPass {
		t.Errorf("401 on private bucket should pass, got %+v", res)
	}
}

func TestCheckB2Anchor_NotFoundFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	res := CheckB2Anchor(B2Config{Endpoint: srv.URL, Bucket: "missing"}).Run(context.Background())
	if res.Status != StatusFail {
		t.Errorf("404 should fail, got %+v", res)
	}
	if !strings.Contains(res.Detail, "missing") {
		t.Errorf("Detail should name the bucket, got %q", res.Detail)
	}
}
