// Package audit appends one JSON-line per session to a local log file.
//
// Phase 4b.6: log files are rotated via natefinch/lumberjack. Defaults
// follow typical sysop expectations (100 MB max per file, 10 backups,
// 30-day retention) so an unattended bridge can run for weeks without
// growing the audit log unbounded. Operators that want OS-level rotation
// (logrotate / journald) can still get the same behavior — lumberjack
// is process-local and does not interfere with external rotation tools
// touching the same file (it reopens cleanly on its next write).
package audit

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gopkg.in/natefinch/lumberjack.v2"
)

// Entry is one audit row.
type Entry struct {
	TS             string `json:"ts"`
	SubmissionID   string `json:"submission_id"`
	ClientIP       string `json:"client_ip"`
	AuthUser       string `json:"auth_user"`
	Accepted       bool   `json:"accepted"`
	UpstreamStatus int    `json:"upstream_status"`
	MessageSize    int    `json:"message_size"`
	Error          string `json:"error,omitempty"`
}

// Defaults applied when New is called without explicit RotateOptions.
// Tunable via NewWithOptions for tests / operators.
const (
	defaultMaxSizeMB  = 100
	defaultMaxBackups = 10
	defaultMaxAgeDays = 30
)

// RotateOptions configures size-based log rotation.
type RotateOptions struct {
	MaxSizeMB  int
	MaxBackups int
	MaxAgeDays int
	Compress   bool
}

// Logger appends entries to a file. Safe for concurrent use.
type Logger struct {
	mu sync.Mutex
	w  io.WriteCloser
}

// New opens (or creates) the file at path with default rotation.
func New(path string) (*Logger, error) {
	return NewWithOptions(path, RotateOptions{})
}

// NewWithOptions opens (or creates) the file at path with the given
// rotation knobs. Zero values inherit the package defaults.
func NewWithOptions(path string, opts RotateOptions) (*Logger, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if opts.MaxSizeMB == 0 {
		opts.MaxSizeMB = defaultMaxSizeMB
	}
	if opts.MaxBackups == 0 {
		opts.MaxBackups = defaultMaxBackups
	}
	if opts.MaxAgeDays == 0 {
		opts.MaxAgeDays = defaultMaxAgeDays
	}
	w := &lumberjack.Logger{
		Filename:   path,
		MaxSize:    opts.MaxSizeMB,
		MaxBackups: opts.MaxBackups,
		MaxAge:     opts.MaxAgeDays,
		Compress:   opts.Compress,
		LocalTime:  false,
	}
	return &Logger{w: w}, nil
}

// Write serializes the entry as a JSON line.
func (l *Logger) Write(e Entry) error {
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(time.RFC3339Nano)
	}
	b, err := json.Marshal(&e)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err = l.w.Write(b)
	return err
}

// Close closes the file.
func (l *Logger) Close() error { return l.w.Close() }
