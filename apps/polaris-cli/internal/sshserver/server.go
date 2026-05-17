// SSH server bootstrap — wires Wish, middleware, and the bubbletea handler
// into a single *ssh.Server returned to the cobra command.
package sshserver

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/charmbracelet/log"
	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish"
	"github.com/charmbracelet/wish/activeterm"
	"github.com/charmbracelet/wish/bubbletea"
	"github.com/charmbracelet/wish/logging"
	"github.com/muesli/termenv"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// Config is the user-visible knob set, parsed by the `serve` cobra cmd.
type Config struct {
	Host         string
	Port         int
	HostKeyPath  string
	Bootstrap    *client.Client // already signed-as-bootstrap-key
	LookupTTL    time.Duration
	IdleTimeout  time.Duration
	MaxSessions  int
	Theme        string
}

func (c Config) addr() string {
	if c.Host == "" {
		return fmt.Sprintf(":%d", c.Port)
	}
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// Run starts the SSH server and blocks until ctx is cancelled (or SIGINT).
func Run(ctx context.Context, cfg Config) error {
	if cfg.Bootstrap == nil {
		return errors.New("bootstrap client required (carries admin:impersonate)")
	}
	if cfg.Port == 0 {
		cfg.Port = 2222
	}
	if cfg.HostKeyPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("home dir: %w", err)
		}
		cfg.HostKeyPath = filepath.Join(home, ".config", "polaris-email", "ssh_host_ed25519")
	}
	if err := os.MkdirAll(filepath.Dir(cfg.HostKeyPath), 0o700); err != nil {
		return fmt.Errorf("make host key dir: %w", err)
	}
	cache := NewCache(cfg.Bootstrap, cfg.LookupTTL)

	s, err := wish.NewServer(
		wish.WithAddress(cfg.addr()),
		wish.WithHostKeyPath(cfg.HostKeyPath),
		wish.WithPublicKeyAuth(func(_ ssh.Context, _ ssh.PublicKey) bool {
			// Always accept; the middleware rejects unknown keys with a
			// friendly banner so operators can copy their fingerprint.
			return true
		}),
		wish.WithIdleTimeout(cfg.idleOrDefault()),
		wish.WithMiddleware(
			bubbletea.MiddlewareWithProgramHandler(newProgramHandler(cfg.Bootstrap, cfg.Theme), termenv.ANSI256),
			requireOperatorMiddleware(cache),
			activeterm.Middleware(),
			logging.Middleware(),
		),
	)
	if err != nil {
		return fmt.Errorf("wish server: %w", err)
	}

	done := make(chan struct{}, 1)
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case <-ctx.Done():
		case <-sigs:
		}
		log.Info("polaris-email serve --ssh shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = s.Shutdown(shutdownCtx)
		done <- struct{}{}
	}()

	log.Info("polaris-email SSH server listening", "addr", cfg.addr())
	if err := s.ListenAndServe(); err != nil && !errors.Is(err, ssh.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("listen: %w", err)
	}
	<-done
	return nil
}

func (c Config) idleOrDefault() time.Duration {
	if c.IdleTimeout > 0 {
		return c.IdleTimeout
	}
	return 30 * time.Minute
}
