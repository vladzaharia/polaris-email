package cfapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestD1_List(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/accounts/acc-test/d1/database") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write(cfSuccess([]D1Database{
			{UUID: "db-1", Name: "polaris-email"},
		}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.ListDatabases(context.Background())
	if err != nil {
		t.Fatalf("ListDatabases: %v", err)
	}
	if len(got) != 1 || got[0].UUID != "db-1" {
		t.Errorf("got %+v", got)
	}
}

func TestD1_Get(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/d1/database/db-1") {
			t.Errorf("path: %s", r.URL.Path)
		}
		_, _ = w.Write(cfSuccess(D1Database{UUID: "db-1", Name: "polaris-email"}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.GetDatabase(context.Background(), "db-1")
	if err != nil {
		t.Fatalf("GetDatabase: %v", err)
	}
	if got.Name != "polaris-email" {
		t.Errorf("got %+v", got)
	}
}

func TestD1_Create_HappyPath(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method: %s", r.Method)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "polaris-email" {
			t.Errorf("body: %+v", body)
		}
		_, _ = w.Write(cfSuccess(D1Database{UUID: "new-uuid", Name: body["name"]}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.CreateDatabase(context.Background(), "polaris-email")
	if err != nil {
		t.Fatalf("CreateDatabase: %v", err)
	}
	if got.UUID != "new-uuid" {
		t.Errorf("got %+v", got)
	}
}

func TestD1_Create_AlreadyExistsRefetches(t *testing.T) {
	t.Parallel()
	postHits, listHits := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			postHits++
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write(cfFailure(map[string]any{"code": 7405, "message": "already exists"}))
		case http.MethodGet:
			listHits++
			_, _ = w.Write(cfSuccess([]D1Database{{UUID: "existing-uuid", Name: "polaris-email"}}))
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.CreateDatabase(context.Background(), "polaris-email")
	if err != nil {
		t.Fatalf("CreateDatabase: %v", err)
	}
	if got.UUID != "existing-uuid" {
		t.Errorf("want existing-uuid, got %+v", got)
	}
	if postHits != 1 || listHits != 1 {
		t.Errorf("want 1 POST + 1 GET, got POST=%d GET=%d", postHits, listHits)
	}
}
