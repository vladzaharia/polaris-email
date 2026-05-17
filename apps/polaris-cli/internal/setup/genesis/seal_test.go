package genesis

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer is a small httptest harness for the bootstrap +
// webauthn-poll endpoints. The behaviour is configurable per-test so
// each scenario can flip the "ceremony complete" bit at the right
// moment.
type fakeServer struct {
	mu             sync.Mutex
	bootstrapCalls int
	pollCalls      int
	completeCalls  int

	// failBootstrap, when non-nil, replaces the bootstrap handler
	// entirely (used for the 409 case).
	failBootstrap func(w http.ResponseWriter, r *http.Request)

	// pollSequence is the queue of statuses to return from the poll
	// endpoint. Each call dequeues; the final entry is returned for
	// all subsequent polls. Defaults to ["pending", "pending", "complete"].
	pollSequence []string

	// idempotencyStore caches bootstrap responses by Idempotency-Key.
	idempotencyStore map[string][]byte

	srv *httptest.Server
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	f := &fakeServer{
		pollSequence:     []string{"pending", "pending", "complete"},
		idempotencyStore: map[string][]byte{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/admin/bootstrap", f.handleBootstrap)
	mux.HandleFunc("/v1/admin/setup/webauthn/", f.handleWebauthn)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.bootstrapCalls++
	f.mu.Unlock()
	if f.failBootstrap != nil {
		f.failBootstrap(w, r)
		return
	}
	idem := r.Header.Get("Idempotency-Key")
	if idem != "" {
		if cached, ok := f.idempotencyStore[idem]; ok {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(cached)
			return
		}
	}
	body := map[string]string{
		"admin_key_id":       "01TESTKEY00000000000000000",
		"admin_key_secret":   "test-secret-abcdef",
		"mailbox_id":         "01TESTMAILBOX0000000000000",
		"setup_code":         "TESTCODE12345678",
		"webauthn_enrol_url": "http://" + r.Host + "/setup/webauthn?code=TESTCODE12345678",
	}
	resp, _ := json.Marshal(body)
	if idem != "" {
		f.idempotencyStore[idem] = resp
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(resp)
}

func (f *fakeServer) handleWebauthn(w http.ResponseWriter, r *http.Request) {
	// Two shapes: GET .../<code> (poll) and POST .../<code>/complete.
	path := strings.TrimPrefix(r.URL.Path, "/v1/admin/setup/webauthn/")
	if strings.HasSuffix(path, "/complete") {
		f.mu.Lock()
		f.completeCalls++
		f.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"complete"}`))
		return
	}
	f.mu.Lock()
	idx := f.pollCalls
	f.pollCalls++
	f.mu.Unlock()
	status := "pending"
	if len(f.pollSequence) > 0 {
		if idx < len(f.pollSequence) {
			status = f.pollSequence[idx]
		} else {
			status = f.pollSequence[len(f.pollSequence)-1]
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"` + status + `"}`))
}

func (f *fakeServer) baseURL() string { return f.srv.URL }

func tempOutputPath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, ".bootstrap-output.json")
}

func TestSeal_HappyPath(t *testing.T) {
	srv := newFakeServer(t)
	out := tempOutputPath(t)
	var openedURL string
	res, err := Seal(context.Background(), SealOptions{
		APIBaseURL:    srv.baseURL(),
		MasterSecret:  "test-secret-A",
		OutputPath:    out,
		NoBrowser:     false,
		PollInterval:  10 * time.Millisecond,
		PollTimeout:   2 * time.Second,
		Out:           io.Discard,
		BrowserOpener: func(u string) error { openedURL = u; return nil },
	})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if res.AdminKeyID != "01TESTKEY00000000000000000" {
		t.Errorf("admin_key_id mismatch: %s", res.AdminKeyID)
	}
	if !res.WebAuthnEnrolled {
		t.Error("expected WebAuthnEnrolled=true")
	}
	if openedURL == "" {
		t.Error("expected browser opener to be invoked")
	}
	if !strings.Contains(openedURL, "TESTCODE12345678") {
		t.Errorf("openedURL missing setup code: %s", openedURL)
	}
	// Bootstrap output should be on disk mode 0600.
	stat, err := os.Stat(out)
	if err != nil {
		t.Fatalf("stat output: %v", err)
	}
	if stat.Mode().Perm() != 0o600 {
		t.Errorf("expected mode 0600, got %s", stat.Mode())
	}
	raw, _ := os.ReadFile(out)
	var disk struct {
		AdminKeyID     string `json:"admin_key_id"`
		AdminKeySecret string `json:"admin_key_secret"`
	}
	if err := json.Unmarshal(raw, &disk); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if disk.AdminKeyID != res.AdminKeyID {
		t.Errorf("disk admin_key_id mismatch")
	}
}

func TestSeal_NoBrowser(t *testing.T) {
	srv := newFakeServer(t)
	called := false
	_, err := Seal(context.Background(), SealOptions{
		APIBaseURL:    srv.baseURL(),
		MasterSecret:  "secret",
		OutputPath:    tempOutputPath(t),
		NoBrowser:     true,
		PollInterval:  5 * time.Millisecond,
		PollTimeout:   2 * time.Second,
		Out:           io.Discard,
		BrowserOpener: func(string) error { called = true; return nil },
	})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if called {
		t.Error("browser opener should not be called with NoBrowser=true")
	}
}

func TestSeal_HeadlessWebAuthnToken(t *testing.T) {
	srv := newFakeServer(t)
	res, err := Seal(context.Background(), SealOptions{
		APIBaseURL:    srv.baseURL(),
		MasterSecret:  "secret",
		WebAuthnToken: "fake-jwt-token",
		OutputPath:    tempOutputPath(t),
		Out:           io.Discard,
		PollInterval:  10 * time.Millisecond,
		PollTimeout:   1 * time.Second,
	})
	if err != nil {
		t.Fatalf("Seal headless: %v", err)
	}
	if !res.WebAuthnEnrolled {
		t.Error("expected WebAuthnEnrolled=true on headless path")
	}
	if srv.completeCalls != 1 {
		t.Errorf("expected 1 /complete call, got %d", srv.completeCalls)
	}
	if srv.pollCalls != 0 {
		t.Errorf("expected 0 poll calls on headless path, got %d", srv.pollCalls)
	}
}

func TestSeal_AlreadyBootstrapped(t *testing.T) {
	srv := newFakeServer(t)
	srv.failBootstrap = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"already_bootstrapped","message":"bootstrap already consumed","retryable":false,"request_id":"req-1"}}`))
	}
	_, err := Seal(context.Background(), SealOptions{
		APIBaseURL:   srv.baseURL(),
		MasterSecret: "secret",
		OutputPath:   tempOutputPath(t),
		Out:          io.Discard,
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsAlreadyBootstrapped(err) {
		t.Errorf("expected AlreadyBootstrappedError, got %T: %v", err, err)
	}
}

func TestSeal_IdempotencyReplay(t *testing.T) {
	srv := newFakeServer(t)
	idem := "test-idem-key"
	out1 := tempOutputPath(t)
	res1, err := Seal(context.Background(), SealOptions{
		APIBaseURL:     srv.baseURL(),
		MasterSecret:   "secret",
		IdempotencyKey: idem,
		WebAuthnToken:  "headless-token", // skip poll for speed
		OutputPath:     out1,
		Out:            io.Discard,
	})
	if err != nil {
		t.Fatalf("first Seal: %v", err)
	}
	// Re-run with the same idempotency key — server should replay.
	out2 := tempOutputPath(t)
	res2, err := Seal(context.Background(), SealOptions{
		APIBaseURL:     srv.baseURL(),
		MasterSecret:   "secret",
		IdempotencyKey: idem,
		WebAuthnToken:  "headless-token",
		OutputPath:     out2,
		Out:            io.Discard,
	})
	if err != nil {
		t.Fatalf("replay Seal: %v", err)
	}
	if res1.AdminKeyID != res2.AdminKeyID {
		t.Errorf("idempotency replay returned different key: %s vs %s",
			res1.AdminKeyID, res2.AdminKeyID)
	}
	if res1.AdminKeySecret != res2.AdminKeySecret {
		t.Error("idempotency replay returned different secret")
	}
}

func TestSeal_RejectsMissingMasterSecret(t *testing.T) {
	_, err := Seal(context.Background(), SealOptions{APIBaseURL: "http://x"})
	if err == nil {
		t.Fatal("expected error for missing master secret")
	}
}

func TestSeal_RejectsMissingAPIURL(t *testing.T) {
	_, err := Seal(context.Background(), SealOptions{MasterSecret: "x"})
	if err == nil {
		t.Fatal("expected error for missing API URL")
	}
}

func TestSeal_PollTimeout(t *testing.T) {
	srv := newFakeServer(t)
	srv.pollSequence = []string{"pending"} // never completes

	res, err := Seal(context.Background(), SealOptions{
		APIBaseURL:    srv.baseURL(),
		MasterSecret:  "secret",
		OutputPath:    tempOutputPath(t),
		NoBrowser:     true,
		PollInterval:  5 * time.Millisecond,
		PollTimeout:   50 * time.Millisecond,
		Out:           io.Discard,
		BrowserOpener: func(string) error { return nil },
	})
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if res.WebAuthnEnrolled {
		t.Error("expected WebAuthnEnrolled=false on timeout")
	}
	// Admin key should still be on disk.
	if _, err := os.Stat(res.AdminKeyID); err == nil {
		t.Error("admin key ID shouldn't be a path")
	}
}

func TestSeal_ExpiredSetupCode(t *testing.T) {
	srv := newFakeServer(t)
	srv.pollSequence = []string{"expired"}
	res, err := Seal(context.Background(), SealOptions{
		APIBaseURL:    srv.baseURL(),
		MasterSecret:  "secret",
		OutputPath:    tempOutputPath(t),
		NoBrowser:     true,
		PollInterval:  5 * time.Millisecond,
		PollTimeout:   1 * time.Second,
		Out:           io.Discard,
		BrowserOpener: func(string) error { return nil },
	})
	if err == nil {
		t.Fatal("expected ErrSetupCodeExpired")
	}
	if err != ErrSetupCodeExpired {
		t.Errorf("expected ErrSetupCodeExpired, got %v", err)
	}
	if res == nil {
		t.Fatal("expected SealResult returned alongside expired-code err")
	}
	if res.WebAuthnEnrolled {
		t.Error("expected WebAuthnEnrolled=false on expired-code path")
	}
}
