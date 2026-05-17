package cfapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestKV_List(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(cfSuccess([]KVNamespace{
			{ID: "kv-1", Title: "POLARIS_NONCE_DEDUP"},
		}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.ListNamespaces(context.Background())
	if err != nil {
		t.Fatalf("ListNamespaces: %v", err)
	}
	if len(got) != 1 || got[0].ID != "kv-1" {
		t.Errorf("got %+v", got)
	}
}

func TestKV_Create_AlreadyExistsRefetches(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write(cfFailure(map[string]any{"code": 10014, "message": "already exists"}))
		case http.MethodGet:
			_, _ = w.Write(cfSuccess([]KVNamespace{
				{ID: "existing-kv", Title: "POLARIS_NONCE_DEDUP"},
			}))
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.CreateNamespace(context.Background(), "POLARIS_NONCE_DEDUP")
	if err != nil {
		t.Fatalf("CreateNamespace: %v", err)
	}
	if got.ID != "existing-kv" {
		t.Errorf("want existing-kv, got %+v", got)
	}
}

func TestKV_Get(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(cfSuccess(KVNamespace{ID: "kv-1", Title: "X"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.GetNamespace(context.Background(), "kv-1")
	if err != nil {
		t.Fatalf("GetNamespace: %v", err)
	}
	if got.Title != "X" {
		t.Errorf("got %+v", got)
	}
}
