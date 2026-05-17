package cfapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestR2_List_SendsJurisdictionHeader(t *testing.T) {
	t.Parallel()
	var gotJur string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotJur = r.Header.Get("cf-r2-jurisdiction")
		_, _ = w.Write(cfSuccess(map[string]any{
			"buckets": []map[string]any{
				{"name": "polaris-mail-archive"},
			},
		}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.ListBuckets(context.Background(), "eu")
	if err != nil {
		t.Fatalf("ListBuckets: %v", err)
	}
	if gotJur != "eu" {
		t.Errorf("want jurisdiction header eu, got %q", gotJur)
	}
	if len(got) != 1 || got[0].Name != "polaris-mail-archive" {
		t.Errorf("got %+v", got)
	}
	if got[0].Jurisdiction != "eu" {
		t.Errorf("jurisdiction should be stamped onto the bucket, got %q", got[0].Jurisdiction)
	}
}

func TestR2_Create_HappyPath(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("cf-r2-jurisdiction") != "eu" {
			t.Errorf("want jurisdiction header eu, got %q", r.Header.Get("cf-r2-jurisdiction"))
		}
		_, _ = w.Write(cfSuccess(R2Bucket{Name: "polaris-mail-archive"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.CreateBucket(context.Background(), CreateBucketInput{Name: "polaris-mail-archive", Jurisdiction: "eu"})
	if err != nil {
		t.Fatalf("CreateBucket: %v", err)
	}
	if got.Name != "polaris-mail-archive" || got.Jurisdiction != "eu" {
		t.Errorf("got %+v", got)
	}
}

func TestR2_Create_AlreadyExistsRefetches(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write(cfFailure(map[string]any{"code": 10004, "message": "already exists"}))
		case http.MethodGet:
			_, _ = w.Write(cfSuccess(R2Bucket{Name: "polaris-mail-archive"}))
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.CreateBucket(context.Background(), CreateBucketInput{Name: "polaris-mail-archive", Jurisdiction: "eu"})
	if err != nil {
		t.Fatalf("CreateBucket: %v", err)
	}
	if got.Name != "polaris-mail-archive" {
		t.Errorf("got %+v", got)
	}
}
