package cmds

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

// mockServer spins up an httptest.Server that routes by (method, path) to the
// supplied handler map. Unmatched requests fail the test. The server URL is
// returned so the caller can construct a *client.Client pointed at it.
func mockServer(t *testing.T, handlers map[string]func(t *testing.T, r *http.Request, w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.Path
		h, ok := handlers[key]
		if !ok {
			t.Errorf("mockServer: unexpected request %s", key)
			http.Error(w, "no handler", http.StatusNotImplemented)
			return
		}
		h(t, r, w)
	}))
	t.Cleanup(srv.Close)
	_ = mux // kept for symmetry; mux not used since we route inline
	return srv
}

// newTestClient wires a *client.Client at the given base URL with a dummy
// HMAC secret. The mock server doesn't verify signatures (the SDK's signing
// runs unconditionally so we still exercise the canonicalisation, just not
// the verifier on the other end).
func newTestClient(baseURL string) *client.Client {
	return client.New(baseURL, "test-key", "test-secret")
}

// withTableFormat forces the table renderer regardless of any prior global
// state from earlier tests. Cleanup restores whatever was set.
func withTableFormat(t *testing.T) {
	t.Helper()
	prev := G.OutputFmt
	G.OutputFmt = string(output.FormatTable)
	t.Cleanup(func() { G.OutputFmt = prev })
}

func TestCFZoneList_TableRendering(t *testing.T) {
	out, _ := withCapturedIO(t)
	withTableFormat(t)

	resp := client.CFZonesListResponse{
		Data: []client.ZoneDomainStatus{
			{
				Zone:               client.ZoneSummary{ID: "zid1", Name: "ok.example"},
				RoutingEnabled:     true,
				RoutingStatusOK:    true,
				DNSRecordsLocked:   true,
				SenderOnboarded:    true,
				CatchAllCorrect:    true,
				D1MailDomainExists: true,
				Overall:            "ok",
			},
			{
				Zone:                client.ZoneSummary{ID: "zid2", Name: "warn.example"},
				RoutingEnabled:      true,
				RoutingStatusOK:     true,
				DNSRecordsLocked:    true,
				SenderOnboarded:     true,
				CatchAllCorrect:     true,
				D1MailDomainExists:  true,
				HasConflictingRules: true,
				NamedRules: []client.NamedRouteRule{
					{Name: "support", AddressPattern: "support@warn.example", RoutesToPolaris: false, Enabled: true},
				},
				Overall: "warn",
			},
		},
		FetchedAt: "2026-05-15T00:00:00Z",
		Cached:    false,
	}

	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"GET /v1/admin/cf-zones": func(t *testing.T, r *http.Request, w http.ResponseWriter) {
			if r.URL.Query().Get("refresh") != "" {
				t.Errorf("expected no refresh query, got %q", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(resp)
		},
	})

	cl := newTestClient(srv.URL)
	if err := runCFZoneList(CtxBackground(), cl, false); err != nil {
		t.Fatalf("runCFZoneList: %v", err)
	}

	got := out.String()
	// Header columns
	for _, col := range []string{"NAME", "OVERALL", "ROUTING", "DNS", "SENDER", "CATCH-ALL", "RULES", "D1"} {
		if !strings.Contains(got, col) {
			t.Errorf("missing column %q in output:\n%s", col, got)
		}
	}
	if !strings.Contains(got, "ok.example") || !strings.Contains(got, "warn.example") {
		t.Errorf("expected both zone names; got:\n%s", got)
	}
	if !strings.Contains(got, "ok") || !strings.Contains(got, "warn") {
		t.Errorf("expected overall states ok/warn; got:\n%s", got)
	}
	// The warn zone has a conflicting named rule -> rules glyph should be ⚠.
	if !strings.Contains(got, glyphWarn) {
		t.Errorf("expected warn glyph in output:\n%s", got)
	}
}

func TestCFZoneList_RefreshFlagPropagates(t *testing.T) {
	withCapturedIO(t)
	withTableFormat(t)

	called := false
	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"GET /v1/admin/cf-zones": func(t *testing.T, r *http.Request, w http.ResponseWriter) {
			called = true
			if r.URL.Query().Get("refresh") != "1" {
				t.Errorf("expected refresh=1, got %q", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(client.CFZonesListResponse{Data: nil, FetchedAt: "now", Cached: false})
		},
	})

	cl := newTestClient(srv.URL)
	if err := runCFZoneList(CtxBackground(), cl, true); err != nil {
		t.Fatalf("runCFZoneList: %v", err)
	}
	if !called {
		t.Fatal("server handler was never invoked")
	}
}

func TestCFZoneStatus_RendersAllChecks(t *testing.T) {
	out, _ := withCapturedIO(t)
	withTableFormat(t)

	target := "polaris-mail-in"
	resp := client.CFZoneGetResponse{
		Data: client.ZoneDomainStatus{
			Zone:                 client.ZoneSummary{ID: "zid", Name: "plrs.im"},
			RoutingEnabled:       true,
			RoutingStatus:        "ready",
			RoutingStatusOK:      true,
			DNSRecordsLocked:     true,
			DNSRecordErrors:      nil,
			SenderOnboarded:      false,
			SenderMissingRecords: []string{"_dmarc TXT", "v=spf1 ..."},
			CatchAllTarget:       &target,
			CatchAllCorrect:      true,
			NamedRules: []client.NamedRouteRule{
				{Name: "noc", AddressPattern: "noc@plrs.im", ActionType: "forward", ActionTarget: "ops@elsewhere.com", RoutesToPolaris: false, Enabled: true},
			},
			HasConflictingRules: true,
			D1MailDomainExists:  true,
			Overall:             "warn",
		},
	}

	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"GET /v1/admin/cf-zones/plrs.im": func(t *testing.T, _ *http.Request, w http.ResponseWriter) {
			_ = json.NewEncoder(w).Encode(resp)
		},
	})

	cl := newTestClient(srv.URL)
	if err := runCFZoneStatus(CtxBackground(), cl, "plrs.im"); err != nil {
		t.Fatalf("runCFZoneStatus: %v", err)
	}

	got := out.String()
	for _, want := range []string{
		"Zone: plrs.im",
		"Email Routing",
		"DNS records locked",
		"Sender domain onboarded",
		"missing: _dmarc TXT",
		"Catch-all rule",
		"polaris-mail-in",
		"Named rules",
		"noc@plrs.im",
		"D1 mail_domains row present",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in status output:\n%s", want, got)
		}
	}
}

func TestCFZoneConfigureDryRun(t *testing.T) {
	out, _ := withCapturedIO(t)
	withTableFormat(t)

	resp := client.ZoneConfigureResult{
		DryRun: true,
		Diff: client.ZoneConfigureDiff{
			Zone: client.ZoneSummary{ID: "zid", Name: "plrs.im"},
			Ops: []client.ZoneConfigureOp{
				{Kind: "enable_routing", Description: "Enable Cloudflare Email Routing on plrs.im"},
				{Kind: "set_catch_all_worker", Description: "Point catch-all rule at the polaris-mail-in Worker"},
			},
			Warnings: []string{"2 named-address rule(s) on plrs.im route mail elsewhere"},
		},
	}

	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"POST /v1/admin/cf-zones/plrs.im/configure": func(t *testing.T, r *http.Request, w http.ResponseWriter) {
			b, _ := io.ReadAll(r.Body)
			var got map[string]any
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("body unmarshal: %v", err)
			}
			if got["dry_run"] != true {
				t.Errorf("expected dry_run=true in body, got %v", got)
			}
			if _, hasOps := got["op_kinds"]; hasOps {
				t.Errorf("expected no op_kinds when not filtering, got %v", got)
			}
			_ = json.NewEncoder(w).Encode(resp)
		},
	})

	cl := newTestClient(srv.URL)
	if err := runCFZoneConfigure(CtxBackground(), cl, "plrs.im", false /*apply*/, nil); err != nil {
		t.Fatalf("runCFZoneConfigure: %v", err)
	}

	got := out.String()
	for _, want := range []string{
		"Zone: plrs.im",
		"Diff:",
		"enable_routing",
		"set_catch_all_worker",
		"Warnings:",
		"named-address rule(s) on plrs.im route mail elsewhere",
		"(dry run — pass --apply to actually configure)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in configure dry-run output:\n%s", want, got)
		}
	}
}

func TestCFZoneConfigureApplySuccess(t *testing.T) {
	out, _ := withCapturedIO(t)
	withTableFormat(t)

	op1 := client.ZoneConfigureOp{Kind: "enable_routing", Description: "Enable CF Email Routing"}
	op2 := client.ZoneConfigureOp{Kind: "create_d1_mail_domain", Description: "Create polaris-mail mail_domains row"}
	resp := client.ZoneConfigureResult{
		DryRun: false,
		Diff: client.ZoneConfigureDiff{
			Zone: client.ZoneSummary{Name: "plrs.im"},
			Ops:  []client.ZoneConfigureOp{op1, op2},
		},
		Result: &client.ZoneConfigureApplyResult{
			Applied:      []client.ZoneConfigureOp{op1, op2},
			Failed:       nil,
			AllSucceeded: true,
		},
	}

	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"POST /v1/admin/cf-zones/plrs.im/configure": func(t *testing.T, r *http.Request, w http.ResponseWriter) {
			b, _ := io.ReadAll(r.Body)
			var got map[string]any
			_ = json.Unmarshal(b, &got)
			if got["dry_run"] != false {
				t.Errorf("expected dry_run=false in body, got %v", got)
			}
			_ = json.NewEncoder(w).Encode(resp)
		},
	})

	cl := newTestClient(srv.URL)
	if err := runCFZoneConfigure(CtxBackground(), cl, "plrs.im", true /*apply*/, nil); err != nil {
		t.Fatalf("runCFZoneConfigure (apply, success): %v", err)
	}

	got := out.String()
	for _, want := range []string{
		"Applied:",
		"enable_routing",
		"create_d1_mail_domain",
		"All ops succeeded.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in configure apply output:\n%s", want, got)
		}
	}
	if strings.Contains(got, "(dry run") {
		t.Errorf("apply path leaked the dry-run footer:\n%s", got)
	}
}

func TestCFZoneConfigureApplyPartialFailure(t *testing.T) {
	out, _ := withCapturedIO(t)
	withTableFormat(t)

	good := client.ZoneConfigureOp{Kind: "enable_routing", Description: "Enable CF Email Routing"}
	bad := client.ZoneConfigureOp{Kind: "set_catch_all_worker", Description: "Point catch-all at polaris-mail-in"}
	resp := client.ZoneConfigureResult{
		DryRun: false,
		Diff: client.ZoneConfigureDiff{
			Zone: client.ZoneSummary{Name: "plrs.im"},
			Ops:  []client.ZoneConfigureOp{good, bad},
		},
		Result: &client.ZoneConfigureApplyResult{
			Applied: []client.ZoneConfigureOp{good},
			Failed: []client.ZoneConfigureAppliedFailure{
				{Op: bad, Error: "catch_all rule id missing"},
			},
			AllSucceeded: false,
		},
	}

	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"POST /v1/admin/cf-zones/plrs.im/configure": func(t *testing.T, _ *http.Request, w http.ResponseWriter) {
			_ = json.NewEncoder(w).Encode(resp)
		},
	})

	cl := newTestClient(srv.URL)
	err := runCFZoneConfigure(CtxBackground(), cl, "plrs.im", true, nil)
	if err == nil {
		t.Fatal("expected error when ops failed; got nil")
	}
	if !strings.Contains(err.Error(), "1 op(s) failed") {
		t.Errorf("expected failure summary in error, got %v", err)
	}

	got := out.String()
	for _, want := range []string{"Applied:", "Failed:", "catch_all rule id missing"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in partial-failure output:\n%s", want, got)
		}
	}
}

func TestCFZoneConfigureOpKindsFilter(t *testing.T) {
	withCapturedIO(t)
	withTableFormat(t)

	srv := mockServer(t, map[string]func(*testing.T, *http.Request, http.ResponseWriter){
		"POST /v1/admin/cf-zones/plrs.im/configure": func(t *testing.T, r *http.Request, w http.ResponseWriter) {
			b, _ := io.ReadAll(r.Body)
			var got map[string]any
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			ops, ok := got["op_kinds"].([]any)
			if !ok {
				t.Fatalf("expected op_kinds slice, got %v", got)
			}
			if len(ops) != 2 || ops[0] != "enable_routing" || ops[1] != "create_d1_mail_domain" {
				t.Errorf("op_kinds mismatch: %v", ops)
			}
			_ = json.NewEncoder(w).Encode(client.ZoneConfigureResult{DryRun: true, Diff: client.ZoneConfigureDiff{Zone: client.ZoneSummary{Name: "plrs.im"}}})
		},
	})

	cl := newTestClient(srv.URL)
	if err := runCFZoneConfigure(CtxBackground(), cl, "plrs.im", false, []string{"enable_routing", "create_d1_mail_domain"}); err != nil {
		t.Fatalf("runCFZoneConfigure: %v", err)
	}
}

func TestCFZoneSplitCSV(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"  ", nil},
		{"a", []string{"a"}},
		{"a,b,c", []string{"a", "b", "c"}},
		{" a , ,b ,", []string{"a", "b"}},
	}
	for _, tc := range cases {
		got := splitCSV(tc.in)
		if !equalStringSlices(got, tc.want) {
			t.Errorf("splitCSV(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
