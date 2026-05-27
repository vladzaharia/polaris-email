// Package mailtest_inproc provides the in-process Harness for the
// mail-test-inproc integration suite. It spawns the compiled bridge
// binary as a subprocess, points it at the in-process Go fake control
// plane, and provides the supervisor pattern that respawns the bridge
// after rolls / restart directives.
package mailtest_inproc

import (
	"bytes"
	"context"
	cryptoRand "crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	mt "github.com/vladzaharia/polaris-email/apps/mail-bridge/test/mailtest"
)

// BridgeBinary is the compiled bridge path set by TestMain. Per-test
// harnesses read this rather than re-compiling.
var BridgeBinary string

// NewFactory returns a mailtest.HarnessFactory using the shared CA. The
// CA is minted once per test package and shared across all tests in the
// run; each individual test still mints its own server cert from the
// same CA.
func NewFactory(ca *mt.CA) mt.HarnessFactory {
	return func(t *testing.T, opts mt.HarnessOpts) mt.Harness {
		return start(t, opts, ca)
	}
}

type inprocHarness struct {
	t       *testing.T
	opts    mt.HarnessOpts
	ca      *mt.CA
	caCfg   *tls.Config // nil when WithoutTLS
	fake    *mt.FakeServer
	bridge  mt.Bridge
	mailboxIDByOwner map[string]string

	tmpDir       string
	keyFile      string
	certDir      string
	mirrorPath   string
	credstorePath string
	auditPath    string

	smtpsPort   int
	smtpPort    int
	imapsPort   int
	imapPort    int
	webhookPort int

	mu           sync.Mutex
	cmd          *exec.Cmd
	cmdExited    chan struct{} // closed by supervise when current cmd exits
	logBuf       *ringBuffer
	stopped      atomic.Bool
	restartCount atomic.Int64
}

// start brings up one harness instance and returns it.
func start(t *testing.T, opts mt.HarnessOpts, ca *mt.CA) mt.Harness {
	t.Helper()
	if BridgeBinary == "" {
		t.Fatal("mailtest_inproc: BridgeBinary not set; TestMain must build it")
	}

	h := &inprocHarness{
		t: t, opts: opts, ca: ca,
		mailboxIDByOwner: map[string]string{},
		logBuf:           newRingBuffer(1 << 20),
	}

	// Build TLS material unless the test opted out.
	if !opts.WithoutTLS && ca != nil {
		h.caCfg = ca.ClientTLSConfig("smtps.test")
	}

	// Fake control plane.
	h.fake = mt.NewFakeServer()
	t.Cleanup(h.fake.Close)

	// Register a bridge so we know its ID + HMAC up front.
	bridgeName := "mailtest-" + shortRand(t)
	h.bridge = h.fake.RegisterBridge(bridgeName)

	// Apply initial settings patch.
	if opts.BridgeSettings != nil {
		h.fake.UpdateSettings(h.bridge, *opts.BridgeSettings)
	}

	// Seed mailboxes/creds/messages.
	for _, m := range opts.InitialMailboxes {
		mb := h.fake.SeedMailbox(m.OwnerAddr)
		h.mailboxIDByOwner[m.OwnerAddr] = mb.ID
	}
	for _, c := range opts.InitialCreds {
		mbID, ok := h.mailboxIDByOwner[c.MailboxOwnerAddr]
		if !ok {
			// Auto-create the mailbox.
			mb := h.fake.SeedMailbox(c.MailboxOwnerAddr)
			mbID = mb.ID
			h.mailboxIDByOwner[c.MailboxOwnerAddr] = mbID
		}
		h.fake.CreateCredential(mt.Mailbox{ID: mbID, OwnerAddr: c.MailboxOwnerAddr}, c.Username, c.Password, c.Protocol)
	}
	for _, m := range opts.InitialMessages {
		// Seed into the first mailbox if MailboxID empty.
		mbID := m.MailboxID
		if mbID == "" {
			for _, id := range h.mailboxIDByOwner {
				mbID = id
				break
			}
		}
		if mbID == "" {
			t.Fatalf("mailtest_inproc: SeedMessage without InitialMailboxes")
		}
		h.fake.SeedMessage(mt.Mailbox{ID: mbID}, m)
	}

	// Per-test temp dir + 5 random ports.
	h.tmpDir = t.TempDir()
	h.certDir = filepath.Join(h.tmpDir, "certs")
	if err := os.MkdirAll(h.certDir, 0o755); err != nil {
		t.Fatalf("mkdir cert dir: %v", err)
	}
	h.mirrorPath = filepath.Join(h.tmpDir, "mirror.db")
	h.credstorePath = filepath.Join(h.tmpDir, "credstore.db")
	h.auditPath = filepath.Join(h.tmpDir, "audit.jsonl")
	h.keyFile = filepath.Join(h.tmpDir, "hmac.key")
	if err := os.WriteFile(h.keyFile, h.bridge.HMACKey, 0o600); err != nil {
		t.Fatalf("write hmac key: %v", err)
	}

	if !opts.WithoutTLS && ca != nil {
		cert := ca.IssueServerCert(t, "smtps.test", "imaps.test", "localhost", "127.0.0.1")
		mt.WritePEMs(t, h.certDir, cert)
	}

	ports := mt.AllocatePorts(t, 5)
	h.smtpsPort, h.smtpPort, h.imapsPort, h.imapPort, h.webhookPort =
		ports[0], ports[1], ports[2], ports[3], ports[4]

	// Sync the fake's stored settings with the bridge's actual bound
	// ports so any later UpdateSettings doesn't trigger restart-required
	// Apply with mismatched production-default ports.
	h.fake.SyncBridgePorts(h.bridge, h.smtpsPort, h.smtpPort, h.imapsPort, h.imapPort)

	return h
}

// -------- Harness impl --------

func (h *inprocHarness) Start(ctx context.Context) error {
	if err := h.spawn(); err != nil {
		return err
	}
	// Supervise: respawn on clean exit so HMAC-roll tests can observe
	// "exit, key file replaced, fresh process" semantics.
	go h.supervise()
	// Wait for first heartbeat.
	waitCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	hb := h.fake.WaitForHeartbeat(waitCtx, h.bridge)
	if hb.ReceivedAt.IsZero() {
		return errors.New("mailtest_inproc: no heartbeat within 15s")
	}
	// Webhook bootstrap is async + optional. Tests that exercise
	// DeliverWebhook should call f.WaitForWebhookBootstrap themselves
	// with their own deadline so non-webhook tests aren't gated.
	return nil
}

func (h *inprocHarness) Stop(ctx context.Context) error {
	h.stopped.Store(true)
	h.mu.Lock()
	cmd := h.cmd
	exited := h.cmdExited
	h.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	// Don't call cmd.Wait here — supervise() is the sole owner of that
	// call. Instead wait for supervise to close exited (or for the
	// deadline to expire, in which case we SIGKILL).
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-exited
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-exited
	}
	return nil
}

func (h *inprocHarness) Bridge() mt.Bridge { return h.bridge }

func (h *inprocHarness) SMTPSAddr() string   { return mt.HostPort("127.0.0.1", h.smtpsPort) }
func (h *inprocHarness) SMTPAddr() string    { return mt.HostPort("127.0.0.1", h.smtpPort) }
func (h *inprocHarness) IMAPSAddr() string   { return mt.HostPort("127.0.0.1", h.imapsPort) }
func (h *inprocHarness) IMAPAddr() string    { return mt.HostPort("127.0.0.1", h.imapPort) }
func (h *inprocHarness) WebhookAddr() string { return mt.HostPort("127.0.0.1", h.webhookPort) }
func (h *inprocHarness) APIBaseURL() string  { return h.fake.URL() }

func (h *inprocHarness) CABundle() *tls.Config { return cloneTLS(h.caCfg) }

func (h *inprocHarness) ReplaceCert(t *testing.T, cert tls.Certificate) {
	t.Helper()
	mt.WritePEMs(t, h.certDir, cert)
}

func (h *inprocHarness) Fake() mt.FakeControlPlane { return h.fake }

func (h *inprocHarness) BridgeLogs() io.Reader { return h.logBuf.NewReader() }

func (h *inprocHarness) SendSignal(sig os.Signal) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cmd == nil || h.cmd.Process == nil {
		return errors.New("no process")
	}
	return h.cmd.Process.Signal(sig)
}

func (h *inprocHarness) RestartBridge(ctx context.Context) error {
	h.mu.Lock()
	cmd := h.cmd
	h.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	// supervise() will respawn.
	return h.WaitForRestart(ctx)
}

func (h *inprocHarness) WaitForRestart(ctx context.Context) error {
	startCount := h.restartCount.Load()
	deadline := time.Now().Add(15 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	for time.Now().Before(deadline) {
		if h.restartCount.Load() > startCount {
			// Wait for first heartbeat from the new process.
			hb := h.fake.WaitForHeartbeat(ctx, h.bridge)
			if hb.ReceivedAt.IsZero() {
				return errors.New("mailtest_inproc: respawned but no heartbeat")
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return errors.New("mailtest_inproc: respawn timeout")
}

func (h *inprocHarness) ReadHMACKeyFile() []byte {
	b, err := os.ReadFile(h.keyFile)
	if err != nil {
		return nil
	}
	// Keys are hex-encoded on disk; the bridge stores the hex bytes as
	// its HMAC secret directly. Return the trimmed disk contents so
	// tests can compare against the value the fake returned from
	// StageHMACRotation (also a hex string).
	return bytes.TrimSpace(b)
}

// -------- internals --------

func (h *inprocHarness) spawn() error {
	env := h.buildEnv()
	cmd := exec.Command(BridgeBinary)
	cmd.Env = env
	cmd.Stdout = h.logBuf
	cmd.Stderr = io.MultiWriter(h.logBuf, &prefixWriter{w: os.Stderr, prefix: "[bridge] "})
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("mailtest_inproc: spawn: %w", err)
	}
	h.mu.Lock()
	h.cmd = cmd
	h.cmdExited = make(chan struct{})
	h.mu.Unlock()
	return nil
}

// supervise watches for clean process exit and respawns. supervise is
// the SOLE caller of cmd.Wait — Stop coordinates via the cmdExited
// channel to avoid the documented race of concurrent Wait calls on the
// same exec.Cmd.
func (h *inprocHarness) supervise() {
	for {
		h.mu.Lock()
		cmd := h.cmd
		exited := h.cmdExited
		h.mu.Unlock()
		if cmd == nil {
			return
		}
		_ = cmd.Wait()
		close(exited)
		if h.stopped.Load() {
			return
		}
		// Process exited unexpectedly. Respawn.
		if err := h.spawn(); err != nil {
			h.t.Logf("mailtest_inproc: respawn failed: %v", err)
			return
		}
		h.restartCount.Add(1)
	}
}

func (h *inprocHarness) buildEnv() []string {
	// Reasonable defaults so tests are fast.
	hbInterval := h.opts.HeartbeatInterval
	if hbInterval == 0 {
		hbInterval = 250 * time.Millisecond
	}
	hbSettle := h.opts.HeartbeatSettle
	if hbSettle == 0 {
		hbSettle = 250 * time.Millisecond
	}
	tlsReload := h.opts.TLSReloadInterval
	if tlsReload == 0 {
		tlsReload = 1 * time.Second
	}
	lockoutCooldown := h.opts.AuthLockoutCooldown
	if lockoutCooldown == 0 {
		lockoutCooldown = 2 * time.Second
	}

	// Pre-bootstrap the bridge's webhook subs by feeding it the mailbox
	// IDs the test seeded. The bridge's webhook bootstrap reads this
	// env var (added to its main.go) and calls Bootstrap.Run on the
	// listed mailboxes, which exercises the fake's POST /v1/admin/webhook-subs
	// and surfaces a secret + URL to DeliverWebhook.
	var bootstrapMailboxes string
	for _, id := range h.mailboxIDByOwner {
		if bootstrapMailboxes != "" {
			bootstrapMailboxes += ","
		}
		bootstrapMailboxes += id
	}

	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"BRIDGE_POLARIS_API_URL=" + h.fake.URL(),
		"BRIDGE_NAME=" + h.bridge.Name,
		"BRIDGE_POLARIS_BRIDGE_ID=" + h.bridge.ID,
		"BRIDGE_POLARIS_HMAC_KEY_FILE=" + h.keyFile,
		"BRIDGE_TLS_CERT_DIR=" + h.certDir,
		"BRIDGE_CREDSTORE_PATH=" + h.credstorePath,
		"BRIDGE_MIRROR_PATH=" + h.mirrorPath,
		"BRIDGE_LOGGING_FILE=" + h.auditPath,
		"BRIDGE_POLL_INTERVAL=1s",
		"BRIDGE_HEARTBEAT_INTERVAL=" + hbInterval.String(),
		"BRIDGE_HEARTBEAT_SETTLE=" + hbSettle.String(),
		"BRIDGE_TLS_RELOAD_INTERVAL=" + tlsReload.String(),
		"BRIDGE_AUTH_LOCKOUT_COOLDOWN=" + lockoutCooldown.String(),
		"BRIDGE_PUBLIC_URL=http://127.0.0.1:" + strconv.Itoa(h.webhookPort),
		"BRIDGE_PUBLIC_URL_ALLOW_LOOPBACK=1",
		"BRIDGE_WEBHOOK_LISTEN_ADDR=127.0.0.1:" + strconv.Itoa(h.webhookPort),
		"BRIDGE_SMTPS_PORT=" + strconv.Itoa(h.smtpsPort),
		"BRIDGE_SMTP_PORT=" + strconv.Itoa(h.smtpPort),
		"BRIDGE_IMAPS_PORT=" + strconv.Itoa(h.imapsPort),
		"BRIDGE_IMAP_PORT=" + strconv.Itoa(h.imapPort),
		"BRIDGE_SMTPS_LISTEN_ADDR=:" + strconv.Itoa(h.smtpsPort),
		"BRIDGE_WEBHOOK_ENABLED=1",
		"BRIDGE_WEBHOOK_BOOTSTRAP_MAILBOXES=" + bootstrapMailboxes,
		"BRIDGE_REFRESH_MAILBOXES=" + bootstrapMailboxes,
		"BRIDGE_REFRESH_INTERVAL=500ms",
	}
	for k, v := range h.opts.ExtraEnv {
		env = append(env, k+"="+v)
	}
	return env
}

func cloneTLS(c *tls.Config) *tls.Config {
	if c == nil {
		return nil
	}
	return c.Clone()
}

// shortRand returns a short hex random suffix for bridge naming.
func shortRand(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := cryptoRand.Read(b[:]); err != nil {
		t.Fatalf("mailtest_inproc: shortRand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

// prefixWriter is a tiny io.Writer that adds a prefix to each line.
// Used so the bridge stderr is interleaved cleanly with test output.
type prefixWriter struct {
	w      io.Writer
	prefix string
	mu     sync.Mutex
	pending []byte
}

func (p *prefixWriter) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := len(b)
	for len(b) > 0 {
		idx := bytes.IndexByte(b, '\n')
		if idx < 0 {
			p.pending = append(p.pending, b...)
			break
		}
		_, _ = p.w.Write([]byte(p.prefix))
		_, _ = p.w.Write(p.pending)
		_, _ = p.w.Write(b[:idx+1])
		p.pending = p.pending[:0]
		b = b[idx+1:]
	}
	return n, nil
}
