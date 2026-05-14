// Package audit appends one JSON-line per session to a local log file.
package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
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

// Logger appends entries to a file. Safe for concurrent use.
type Logger struct {
	mu sync.Mutex
	f  *os.File
}

// New opens (or creates) the file at path.
func New(path string) (*Logger, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, err
	}
	return &Logger{f: f}, nil
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
	_, err = l.f.Write(b)
	return err
}

// Close closes the file.
func (l *Logger) Close() error { return l.f.Close() }
