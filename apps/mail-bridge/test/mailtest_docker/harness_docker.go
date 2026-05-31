//go:build mailtest_docker

// Package mailtest_docker provides the docker-compose Harness for the
// mail-test-docker integration suite. It brings up the mail-bridge as
// a container (built from apps/mail-bridge/Dockerfile) and points it
// at the in-process Go fake control plane bound on all interfaces so
// the container can reach it.
//
// This package is gated by the `mailtest_docker` build tag so the main
// build doesn't pull in any docker-orchestration code.
//
// Run locally:
//
//	go test -tags=mailtest_docker -race -timeout 18m \
//	    ./apps/mail-bridge/test/mailtest_docker/...
//
// Prerequisites:
//   - docker + docker compose v2 available on PATH
//   - The mail-bridge image built or buildable from the repo root
//     (`make -C apps/mail-bridge docker` or rely on auto-build in
//     docker-compose.test.yml)
package mailtest_docker

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

// NewFactory returns a HarnessFactory that brings the bridge up via
// docker-compose. The CA is shared across the package so containers
// minted PEMs trust the test client.
func NewFactory(ca *mt.CA) mt.HarnessFactory {
	return func(t *testing.T, opts mt.HarnessOpts) mt.Harness {
		return start(t, opts, ca)
	}
}

type dockerHarness struct {
	t         *testing.T
	opts      mt.HarnessOpts
	ca        *mt.CA
	caCfg     *tls.Config
	fake      *mt.FakeServer
	bridge    mt.Bridge

	mailboxIDByOwner map[string]string

	tmpDir        string
	composeFile   string
	containerName string

	smtpsPort, smtpPort, imapsPort, imapPort, webhookPort, fakePort int

	stopped      atomic.Bool
	restartCount atomic.Int64
	mu           sync.Mutex
}

func start(t *testing.T, opts mt.HarnessOpts, ca *mt.CA) mt.Harness {
	t.Helper()
	h := &dockerHarness{
		t:                t,
		opts:             opts,
		ca:               ca,
		mailboxIDByOwner: map[string]string{},
	}

	// Allocate published ports for the bridge + a fake-API port. The
	// fake binds on 0.0.0.0 so the bridge container can reach it via
	// host.docker.internal.
	ports := mt.AllocatePorts(t, 6)
	h.smtpsPort, h.smtpPort, h.imapsPort, h.imapPort, h.webhookPort, h.fakePort =
		ports[0], ports[1], ports[2], ports[3], ports[4], ports[5]

	if !opts.WithoutTLS && ca != nil {
		h.caCfg = ca.ClientTLSConfig("smtps.test")
	}

	// Start the fake bound on all interfaces so the bridge container
	// can dial it via host.docker.internal:<port>.
	fake, err := mt.NewFakeServerListen("0.0.0.0:" + strconv.Itoa(h.fakePort))
	if err != nil {
		t.Fatalf("mailtest_docker: fake listen: %v", err)
	}
	t.Cleanup(fake.Close)
	h.fake = fake

	bridgeName := "mailtest-docker-" + strconv.FormatInt(time.Now().UnixNano()%1_000_000, 36)
	h.bridge = h.fake.RegisterBridge(bridgeName)
	h.fake.SyncBridgePorts(h.bridge, h.smtpsPort, h.smtpPort, h.imapsPort, h.imapPort)
	// Mirror inproc: the compose env passes BRIDGE_PUBLIC_URL into the
	// bridge's initialSettings.WebhookURLOverride; the fake must echo
	// the same URL back on first heartbeat or the supervisor sees a
	// diff and restart-loops the bridge.
	h.fake.SyncBridgeWebhookURL(h.bridge, "http://127.0.0.1:"+strconv.Itoa(h.webhookPort))

	for _, m := range opts.InitialMailboxes {
		mb := h.fake.SeedMailbox(m.OwnerAddr)
		h.mailboxIDByOwner[m.OwnerAddr] = mb.ID
	}
	for _, c := range opts.InitialCreds {
		mbID, ok := h.mailboxIDByOwner[c.MailboxOwnerAddr]
		if !ok {
			mb := h.fake.SeedMailbox(c.MailboxOwnerAddr)
			mbID = mb.ID
			h.mailboxIDByOwner[c.MailboxOwnerAddr] = mbID
		}
		h.fake.CreateCredential(mt.Mailbox{ID: mbID, OwnerAddr: c.MailboxOwnerAddr}, c.Username, c.Password, c.Protocol)
	}
	for _, m := range opts.InitialMessages {
		mbID := m.MailboxID
		if mbID == "" {
			for _, id := range h.mailboxIDByOwner {
				mbID = id
				break
			}
		}
		h.fake.SeedMessage(mt.Mailbox{ID: mbID}, m)
	}

	h.tmpDir = t.TempDir()
	h.containerName = "mailtest-bridge-" + bridgeName
	h.composeFile = filepath.Join(h.tmpDir, "docker-compose.test.yml")

	// Write the compose file with the per-test ports + env baked in.
	if err := os.WriteFile(h.composeFile, []byte(h.renderCompose()), 0o644); err != nil {
		t.Fatalf("mailtest_docker: write compose: %v", err)
	}
	// Write secrets the compose mounts read-only. File names match the
	// /run/secrets/<name> paths in BRIDGE_POLARIS_BRIDGE_ID_FILE /
	// BRIDGE_POLARIS_HMAC_KEY_FILE.
	secretsDir := filepath.Join(h.tmpDir, "secrets")
	if err := os.MkdirAll(secretsDir, 0o755); err != nil {
		t.Fatalf("mailtest_docker: mkdir secrets: %v", err)
	}
	if err := os.WriteFile(filepath.Join(secretsDir, "hmac_key"), h.bridge.HMACKey, 0o644); err != nil {
		t.Fatalf("mailtest_docker: write hmac_key: %v", err)
	}
	if err := os.WriteFile(filepath.Join(secretsDir, "bridge_id"), []byte(h.bridge.ID), 0o644); err != nil {
		t.Fatalf("mailtest_docker: write bridge_id: %v", err)
	}
	certDir := filepath.Join(h.tmpDir, "certs")
	if err := os.MkdirAll(certDir, 0o755); err != nil {
		t.Fatalf("mkdir certs: %v", err)
	}
	if !opts.WithoutTLS && ca != nil {
		cert := ca.IssueServerCert(t, "smtps.test", "imaps.test", "localhost", "127.0.0.1")
		mt.WritePEMs(t, certDir, cert)
		// mt.WritePEMs writes privkey.pem at 0o600. Linux docker
		// containers run as the in-image `polaris` user (alpine UID
		// ~101) which doesn't match the host UID owning the bind
		// mount; 0o600 then surfaces as "permission denied" inside the
		// container. Loosen to world-readable for the test mount.
		// (The cert/key are minted per-test and live in t.TempDir(),
		// so they go away when the test ends — no production-secret
		// concern.)
		_ = os.Chmod(filepath.Join(certDir, "privkey.pem"), 0o644)
		_ = os.Chmod(filepath.Join(certDir, "fullchain.pem"), 0o644)
	}

	return h
}

func (h *dockerHarness) Start(ctx context.Context) error {
	if out, err := h.compose("up", "-d", "--wait", "--build"); err != nil {
		// Capture container logs so the failure is debuggable even
		// after Stop runs `down -v`.
		logs, _ := h.compose("logs", "--no-color", "bridge")
		return fmt.Errorf("docker compose up: %w\ncompose output:\n%s\ncontainer logs:\n%s", err, out, logs)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	hb := h.fake.WaitForHeartbeat(waitCtx, h.bridge)
	if hb.ReceivedAt.IsZero() {
		logs, _ := h.compose("logs", "--no-color", "bridge")
		return fmt.Errorf("mailtest_docker: no heartbeat within 30s\ncontainer logs:\n%s", logs)
	}
	return nil
}

func (h *dockerHarness) Stop(ctx context.Context) error {
	h.stopped.Store(true)
	out, err := h.compose("down", "-v", "--remove-orphans")
	if err != nil {
		h.t.Logf("mailtest_docker: compose down: %v\n%s", err, out)
	}
	return nil
}

func (h *dockerHarness) Bridge() mt.Bridge { return h.bridge }

func (h *dockerHarness) SMTPSAddr() string   { return mt.HostPort("127.0.0.1", h.smtpsPort) }
func (h *dockerHarness) SMTPAddr() string    { return mt.HostPort("127.0.0.1", h.smtpPort) }
func (h *dockerHarness) IMAPSAddr() string   { return mt.HostPort("127.0.0.1", h.imapsPort) }
func (h *dockerHarness) IMAPAddr() string    { return mt.HostPort("127.0.0.1", h.imapPort) }
func (h *dockerHarness) WebhookAddr() string { return mt.HostPort("127.0.0.1", h.webhookPort) }
func (h *dockerHarness) APIBaseURL() string  { return h.fake.URL() }

func (h *dockerHarness) CABundle() *tls.Config {
	if h.caCfg == nil {
		return nil
	}
	return h.caCfg.Clone()
}

func (h *dockerHarness) ReplaceCert(t *testing.T, cert tls.Certificate) {
	t.Helper()
	certDir := filepath.Join(h.tmpDir, "certs")
	mt.WritePEMs(t, certDir, cert)
	// Same reason as start(): containerized polaris user needs read.
	_ = os.Chmod(filepath.Join(certDir, "privkey.pem"), 0o644)
	_ = os.Chmod(filepath.Join(certDir, "fullchain.pem"), 0o644)
}

func (h *dockerHarness) Fake() mt.FakeControlPlane { return h.fake }

func (h *dockerHarness) BridgeLogs() io.Reader {
	out, _ := h.compose("logs", "--no-color", "bridge")
	return strings.NewReader(out)
}

func (h *dockerHarness) SendSignal(sig os.Signal) error {
	switch sig {
	case os.Interrupt:
		_, err := h.compose("kill", "-s", "SIGINT", "bridge")
		return err
	}
	_, err := h.compose("kill", "-s", "SIGTERM", "bridge")
	return err
}

func (h *dockerHarness) RestartBridge(ctx context.Context) error {
	_, err := h.compose("restart", "bridge")
	if err != nil {
		return err
	}
	h.restartCount.Add(1)
	return h.WaitForRestart(ctx)
}

func (h *dockerHarness) WaitForRestart(ctx context.Context) error {
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	hb := h.fake.WaitForHeartbeat(waitCtx, h.bridge)
	if hb.ReceivedAt.IsZero() {
		return errors.New("mailtest_docker: no heartbeat after restart")
	}
	return nil
}

func (h *dockerHarness) ReadHMACKeyFile() []byte {
	b, err := os.ReadFile(filepath.Join(h.tmpDir, "hmac.key"))
	if err != nil {
		return nil
	}
	return b
}

// compose runs `docker compose -f <file> -p <project> <args...>` and
// returns combined stdout+stderr.
func (h *dockerHarness) compose(args ...string) (string, error) {
	full := append([]string{"compose", "-f", h.composeFile, "-p", h.containerName}, args...)
	cmd := exec.Command("docker", full...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// renderCompose builds the per-test compose file. We use host.docker.internal
// to reach the fake on the host (works on macOS / Windows; Linux needs the
// extra_hosts directive below).
func (h *dockerHarness) renderCompose() string {
	allowLoopback := "1"
	if h.opts.WithoutTLS {
		allowLoopback = "1"
	}
	return fmt.Sprintf(`services:
  bridge:
    image: polaris-mail-bridge:mailtest
    build:
      context: %[14]s
      dockerfile: apps/mail-bridge/Dockerfile
    container_name: %[1]s
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      BRIDGE_POLARIS_API_URL: "http://host.docker.internal:%[2]d"
      BRIDGE_NAME: %[3]s
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
      BRIDGE_TLS_CERT_DIR: /etc/polaris-bridge/tls
      BRIDGE_PUBLIC_URL: "http://127.0.0.1:%[4]d"
      BRIDGE_PUBLIC_URL_ALLOW_LOOPBACK: "%[13]s"
      BRIDGE_HEARTBEAT_INTERVAL: "250ms"
      BRIDGE_HEARTBEAT_SETTLE: "250ms"
      BRIDGE_REFRESH_INTERVAL: "500ms"
      BRIDGE_TLS_RELOAD_INTERVAL: "1s"
      BRIDGE_AUTH_LOCKOUT_COOLDOWN: "2s"
      BRIDGE_SMTPS_PORT: "%[5]d"
      BRIDGE_SMTP_PORT: "%[6]d"
      BRIDGE_IMAPS_PORT: "%[7]d"
      BRIDGE_IMAP_PORT: "%[8]d"
      BRIDGE_WEBHOOK_LISTEN_ADDR: "0.0.0.0:%[9]d"
      # WebhookEnabled now defaults to false at the bridge level (operators
      # opt in via the panel). Tests need the receiver up from boot so the
      # fake's auto-route delivers events without waiting for a reconcile.
      BRIDGE_WEBHOOK_ENABLED: "true"
      BRIDGE_WEBHOOK_BOOTSTRAP_MAILBOXES: "%[10]s"
      BRIDGE_REFRESH_MAILBOXES: "%[10]s"
    ports:
      - "%[5]d:%[5]d"
      - "%[6]d:%[6]d"
      - "%[7]d:%[7]d"
      - "%[8]d:%[8]d"
      - "%[9]d:%[9]d"
    volumes:
      - %[11]s:/run/secrets:ro
      - %[12]s:/etc/polaris-bridge/tls:ro
`,
		h.containerName,                       // 1
		h.fakePort,                            // 2
		h.bridge.Name,                         // 3
		h.webhookPort,                         // 4
		h.smtpsPort,                           // 5
		h.smtpPort,                            // 6
		h.imapsPort,                           // 7
		h.imapPort,                            // 8
		h.webhookPort,                         // 9
		strings.Join(h.mailboxIDList(), ","),  // 10
		filepath.Join(h.tmpDir, "secrets"),    // 11 (secrets bind mount)
		filepath.Join(h.tmpDir, "certs"),      // 12 (cert bind mount)
		allowLoopback,                         // 13
		repoRoot(),                            // 14
	)
}

func (h *dockerHarness) mailboxIDList() []string {
	out := make([]string, 0, len(h.mailboxIDByOwner))
	for _, id := range h.mailboxIDByOwner {
		out = append(out, id)
	}
	return out
}

// repoRoot walks up from the package dir until it finds go.mod. Used
// as docker build context.
func repoRoot() string {
	dir, _ := os.Getwd()
	for d := dir; d != "/" && d != "."; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "pnpm-workspace.yaml")); err == nil {
			return d
		}
	}
	// Fallback: assume we're in apps/mail-bridge/test/mailtest_docker
	// and the repo root is four levels up.
	return filepath.Join(dir, "..", "..", "..", "..")
}
