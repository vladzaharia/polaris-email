package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// Runner is the injectable boundary for shelling out to docker. Tests
// substitute a stub Runner; production code uses ExecRunner.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (stdout, stderr []byte, exitCode int, err error)
}

// ExecRunner is the default Runner — a thin wrapper around
// `exec.CommandContext` that buffers stdout/stderr.
type ExecRunner struct {
	// Stdin is optional; when non-nil it is piped to the child.
	Stdin io.Reader
}

// Run executes the binary and returns captured streams. Non-zero exit
// codes are returned as a non-nil error; the caller still receives
// stdout/stderr to surface to the operator.
func (r ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, []byte, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if r.Stdin != nil {
		cmd.Stdin = r.Stdin
	}
	runErr := cmd.Run()
	exit := 0
	if cmd.ProcessState != nil {
		exit = cmd.ProcessState.ExitCode()
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return stdout.Bytes(), stderr.Bytes(), exit,
				fmt.Errorf("%s %s: exit %d: %s", name, strings.Join(args, " "), exit, strings.TrimSpace(stderr.String()))
		}
		return stdout.Bytes(), stderr.Bytes(), exit, fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), runErr)
	}
	return stdout.Bytes(), stderr.Bytes(), exit, nil
}

// Docker bundles the docker / docker-compose calls the wizard needs.
// Construct one with NewDocker; substitute the Runner in tests.
type Docker struct {
	Runner Runner

	// DockerBinary defaults to "docker"; tests override.
	DockerBinary string
}

// NewDocker returns a Docker that delegates to a fresh ExecRunner.
func NewDocker() *Docker {
	return &Docker{Runner: ExecRunner{}, DockerBinary: "docker"}
}

// Info verifies the docker daemon is reachable. The CLI runs
// `docker info --format {{.ServerVersion}}` and treats any non-zero
// exit as "daemon unreachable".
func (d *Docker) Info(ctx context.Context) (string, error) {
	stdout, _, _, err := d.Runner.Run(ctx, d.bin(), "info", "--format", "{{.ServerVersion}}")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(stdout)), nil
}

// ComposeVersion returns the parsed semver of `docker compose version
// --short`. Returns an error if the output cannot be parsed or compose
// v2 is not installed.
func (d *Docker) ComposeVersion(ctx context.Context) (major, minor, patch int, err error) {
	stdout, _, _, runErr := d.Runner.Run(ctx, d.bin(), "compose", "version", "--short")
	if runErr != nil {
		return 0, 0, 0, runErr
	}
	v := strings.TrimSpace(string(stdout))
	v = strings.TrimPrefix(v, "v")
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return 0, 0, 0, fmt.Errorf("unexpected compose version %q", v)
	}
	major, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parse compose major %q: %w", parts[0], err)
	}
	minor, err = strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("parse compose minor %q: %w", parts[1], err)
	}
	if len(parts) >= 3 {
		// Strip any pre-release suffix on patch (e.g. "2.20.0-desktop-1").
		patchStr := parts[2]
		if idx := strings.IndexAny(patchStr, "-+"); idx >= 0 {
			patchStr = patchStr[:idx]
		}
		patch, _ = strconv.Atoi(patchStr)
	}
	return major, minor, patch, nil
}

// ComposePull runs `docker compose pull` in the supplied project dir.
func (d *Docker) ComposePull(ctx context.Context, projectDir string) ([]byte, error) {
	stdout, _, _, err := d.Runner.Run(ctx, d.bin(), "compose", "--project-directory", projectDir, "pull")
	return stdout, err
}

// ComposeUp runs `docker compose up -d` in the supplied project dir.
func (d *Docker) ComposeUp(ctx context.Context, projectDir string, profiles ...string) ([]byte, error) {
	args := []string{"compose", "--project-directory", projectDir}
	for _, p := range profiles {
		args = append(args, "--profile", p)
	}
	args = append(args, "up", "-d")
	stdout, _, _, err := d.Runner.Run(ctx, d.bin(), args...)
	return stdout, err
}

// ComposeDown runs `docker compose down` in the supplied project dir.
func (d *Docker) ComposeDown(ctx context.Context, projectDir string, volumes bool) ([]byte, error) {
	args := []string{"compose", "--project-directory", projectDir, "down"}
	if volumes {
		args = append(args, "-v")
	}
	stdout, _, _, err := d.Runner.Run(ctx, d.bin(), args...)
	return stdout, err
}

// ContainerStatus is one row of `docker compose ps --format json`.
// Compose v2 emits one JSON object per line (NDJSON).
type ContainerStatus struct {
	ID      string `json:"ID"`
	Name    string `json:"Name"`
	Service string `json:"Service"`
	State   string `json:"State"`  // running|exited|...
	Status  string `json:"Status"` // "Up 5 seconds (healthy)"
	Health  string `json:"Health"` // healthy|unhealthy|starting|""
	Image   string `json:"Image"`
}

// ComposePS lists containers in the compose project. Returns an empty
// slice when no containers are running.
func (d *Docker) ComposePS(ctx context.Context, projectDir string) ([]ContainerStatus, error) {
	stdout, _, _, err := d.Runner.Run(ctx, d.bin(), "compose", "--project-directory", projectDir, "ps", "--format", "json")
	if err != nil {
		return nil, err
	}
	return parseComposePS(stdout)
}

// parseComposePS handles both NDJSON (compose ≥ 2.21) and the older
// single-array JSON encoding compose 2.0–2.20 used.
func parseComposePS(stdout []byte) ([]ContainerStatus, error) {
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var arr []ContainerStatus
		if err := json.Unmarshal(trimmed, &arr); err != nil {
			return nil, fmt.Errorf("parse compose ps array: %w", err)
		}
		return arr, nil
	}
	var out []ContainerStatus
	for _, line := range bytes.Split(trimmed, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var c ContainerStatus
		if err := json.Unmarshal(line, &c); err != nil {
			return nil, fmt.Errorf("parse compose ps line: %w", err)
		}
		out = append(out, c)
	}
	return out, nil
}

// ComposeLogs runs `docker compose logs --tail N <service>`.
func (d *Docker) ComposeLogs(ctx context.Context, projectDir, service string, tail int) ([]byte, error) {
	args := []string{"compose", "--project-directory", projectDir, "logs"}
	if tail > 0 {
		args = append(args, fmt.Sprintf("--tail=%d", tail))
	}
	if service != "" {
		args = append(args, service)
	}
	stdout, _, _, err := d.Runner.Run(ctx, d.bin(), args...)
	return stdout, err
}

func (d *Docker) bin() string {
	if d.DockerBinary == "" {
		return "docker"
	}
	return d.DockerBinary
}
