package mailtest

import (
	"net"
	"net/http"
	"net/http/httptest"
	"time"
)

// NewFakeServerListen is like NewFakeServer but binds on a specific
// host:port (instead of httptest's default 127.0.0.1:0) so docker
// containers can reach the fake from inside the docker network.
//
// Pass ":0" for an ephemeral port on all interfaces, or
// "0.0.0.0:8090" for a fixed bind. Use NewFakeServer for the
// in-process / Tier 1 case — 127.0.0.1 is sufficient there.
func NewFakeServerListen(addr string) (*FakeServer, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	f := &FakeServer{
		state:      newFakeState(),
		httpClient: defaultHTTPClient(),
	}
	mux := newFakeMux(f)
	f.server = &httptest.Server{
		Listener: l,
		Config:   &http.Server{Handler: mux},
	}
	f.server.Start()
	return f, nil
}

// newFakeMux extracts the mux construction so both NewFakeServer and
// NewFakeServerListen share the same handler wiring.
func newFakeMux(f *FakeServer) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/bridge/heartbeat", f.handleHeartbeat)
	mux.HandleFunc("/v1/bridge/config", f.handleBridgeConfig)
	mux.HandleFunc("/v1/bridge/credentials", f.handleCredList)
	mux.HandleFunc("/v1/bridge/credentials/lookup", f.handleCredLookup)
	mux.HandleFunc("/v1/admin/webhook-subs", f.handleWebhookSubs)
	mux.HandleFunc("/v1/messages", f.handleMessages)
	mux.HandleFunc("/v1/messages/", f.handleMessageItem)
	mux.HandleFunc("/v1/messages/get", f.handleMessagesGet)
	mux.HandleFunc("/v1/mailboxes/", f.handleMailboxItem)
	return mux
}

func defaultHTTPClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second}
}
