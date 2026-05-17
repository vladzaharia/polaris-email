package platform

import (
	"context"
	"errors"
	"testing"
)

// stubRunner is an injectable Runner that returns canned outputs for
// fixed argv tuples. Tests register expectations via .On.
type stubRunner struct {
	t        *testing.T
	expected map[string]stubResp
}

type stubResp struct {
	stdout []byte
	stderr []byte
	exit   int
	err    error
}

func newStub(t *testing.T) *stubRunner {
	return &stubRunner{t: t, expected: map[string]stubResp{}}
}

func (s *stubRunner) On(args string, r stubResp) { s.expected[args] = r }

func (s *stubRunner) Run(_ context.Context, name string, args ...string) ([]byte, []byte, int, error) {
	key := name
	for _, a := range args {
		key += " " + a
	}
	r, ok := s.expected[key]
	if !ok {
		s.t.Fatalf("unexpected docker call: %q", key)
	}
	return r.stdout, r.stderr, r.exit, r.err
}

func TestDocker_Info(t *testing.T) {
	stub := newStub(t)
	stub.On("docker info --format {{.ServerVersion}}", stubResp{stdout: []byte("25.0.3\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	v, err := d.Info(context.Background())
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	if v != "25.0.3" {
		t.Fatalf("got %q want 25.0.3", v)
	}
}

func TestDocker_Info_DaemonUnreachable(t *testing.T) {
	stub := newStub(t)
	stub.On("docker info --format {{.ServerVersion}}",
		stubResp{stderr: []byte("Cannot connect to the Docker daemon"), exit: 1, err: errors.New("exit 1")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	if _, err := d.Info(context.Background()); err == nil {
		t.Fatalf("expected error")
	}
}

func TestDocker_ComposeVersion(t *testing.T) {
	tests := []struct {
		name           string
		out            string
		wantMaj, wantMin, wantPat int
	}{
		{"plain", "2.20.0\n", 2, 20, 0},
		{"vprefix", "v2.21.1\n", 2, 21, 1},
		{"prerelease", "2.20.0-desktop-1\n", 2, 20, 0},
		{"minor-only", "2.20\n", 2, 20, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := newStub(t)
			stub.On("docker compose version --short", stubResp{stdout: []byte(tt.out)})
			d := &Docker{Runner: stub, DockerBinary: "docker"}
			maj, min, pat, err := d.ComposeVersion(context.Background())
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if maj != tt.wantMaj || min != tt.wantMin || pat != tt.wantPat {
				t.Fatalf("got %d.%d.%d want %d.%d.%d", maj, min, pat, tt.wantMaj, tt.wantMin, tt.wantPat)
			}
		})
	}
}

func TestDocker_ComposeVersion_BadOutput(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose version --short", stubResp{stdout: []byte("garbage\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	if _, _, _, err := d.ComposeVersion(context.Background()); err == nil {
		t.Fatalf("expected parse error")
	}
}

func TestDocker_ComposePS_NDJSON(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p ps --format json", stubResp{stdout: []byte(
		`{"ID":"abc","Service":"bridge","State":"running","Status":"Up 5s (healthy)","Health":"healthy"}` + "\n" +
			`{"ID":"def","Service":"tailscale","State":"running","Status":"Up 5s","Health":""}` + "\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	cs, err := d.ComposePS(context.Background(), "/tmp/p")
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	if len(cs) != 2 {
		t.Fatalf("got %d containers want 2", len(cs))
	}
	if cs[0].Service != "bridge" || cs[0].Health != "healthy" {
		t.Fatalf("first row mismatch: %+v", cs[0])
	}
}

func TestDocker_ComposePS_LegacyArrayJSON(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p ps --format json", stubResp{stdout: []byte(
		`[{"ID":"abc","Service":"bridge","State":"running"}]`)})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	cs, err := d.ComposePS(context.Background(), "/tmp/p")
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	if len(cs) != 1 || cs[0].Service != "bridge" {
		t.Fatalf("got %+v", cs)
	}
}

func TestDocker_ComposePS_Empty(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p ps --format json", stubResp{stdout: []byte("")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	cs, err := d.ComposePS(context.Background(), "/tmp/p")
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	if len(cs) != 0 {
		t.Fatalf("expected empty, got %+v", cs)
	}
}

func TestDocker_ComposePull(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p pull", stubResp{stdout: []byte("pulled\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	if _, err := d.ComposePull(context.Background(), "/tmp/p"); err != nil {
		t.Fatalf("pull: %v", err)
	}
}

func TestDocker_ComposeUp_Profiles(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p --profile lego up -d", stubResp{stdout: []byte("up\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	if _, err := d.ComposeUp(context.Background(), "/tmp/p", "lego"); err != nil {
		t.Fatalf("up: %v", err)
	}
}

func TestDocker_ComposeDown_WithVolumes(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p down -v", stubResp{stdout: []byte("down\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	if _, err := d.ComposeDown(context.Background(), "/tmp/p", true); err != nil {
		t.Fatalf("down: %v", err)
	}
}

func TestDocker_ComposeLogs(t *testing.T) {
	stub := newStub(t)
	stub.On("docker compose --project-directory /tmp/p logs --tail=50 bridge", stubResp{stdout: []byte("logs\n")})
	d := &Docker{Runner: stub, DockerBinary: "docker"}
	if _, err := d.ComposeLogs(context.Background(), "/tmp/p", "bridge", 50); err != nil {
		t.Fatalf("logs: %v", err)
	}
}
