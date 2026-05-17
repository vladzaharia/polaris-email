package cfapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestQueues_List(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(cfSuccess([]Queue{
			{QueueID: "q-1", QueueName: "polaris-outbound"},
		}))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.ListQueues(context.Background())
	if err != nil {
		t.Fatalf("ListQueues: %v", err)
	}
	if len(got) != 1 || got[0].QueueName != "polaris-outbound" {
		t.Errorf("got %+v", got)
	}
}

func TestQueues_Create_AlreadyExistsRefetches(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write(cfFailure(map[string]any{"code": 100100, "message": "already exists"}))
		case http.MethodGet:
			_, _ = w.Write(cfSuccess([]Queue{
				{QueueID: "existing-q", QueueName: "polaris-outbound"},
			}))
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.CreateQueue(context.Background(), "polaris-outbound")
	if err != nil {
		t.Fatalf("CreateQueue: %v", err)
	}
	if got.QueueID != "existing-q" {
		t.Errorf("want existing-q, got %+v", got)
	}
}
