package upgrader

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// stateFileName is the JSON sidecar that persists Channel + LastCheck
// next to the operator's config.toml. Separate file so a `rm` doesn't
// take credentials with it, and so the upgrader's own parsing surface
// stays trivial.
const stateFileName = "upgrader-state.json"

// DefaultStateDir returns ~/.config/polaris-mail. Tests can override
// by passing an explicit directory to LoadState / SaveState. The
// directory is created as part of SaveState.
func DefaultStateDir() (string, error) {
	if v := os.Getenv("POLARIS_CONFIG_DIR"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "polaris-mail"), nil
}

// LoadState reads the upgrader state file from dir. Missing file →
// returns the zero State (which Resolve treats as "stable channel,
// never checked").
func LoadState(dir string) (State, error) {
	path := filepath.Join(dir, stateFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return State{}, nil
		}
		return State{}, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}, fmt.Errorf("upgrader: parse %s: %w", path, err)
	}
	return s, nil
}

// SaveState atomically writes the state file. Creates the parent dir
// if missing (0700 — operator-only). The file itself is 0600 to match
// the existing config.toml posture.
func SaveState(dir string, s State) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, stateFileName)
	tmp, err := os.CreateTemp(dir, stateFileName+".tmp.*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// MarshalJSON / UnmarshalJSON sit on State so the on-disk format uses
// snake_case keys + RFC3339 time strings — friendlier for any operator
// who pokes at the file with `jq`.
func (s State) MarshalJSON() ([]byte, error) {
	var lastCheck string
	if !s.LastCheck.IsZero() {
		lastCheck = s.LastCheck.UTC().Format(time.RFC3339)
	}
	return json.Marshal(struct {
		Channel         string          `json:"channel,omitempty"`
		LastCheck       string          `json:"last_check,omitempty"`
		LastCheckResult *CheckedUpdate  `json:"last_check_result,omitempty"`
	}{
		Channel:         s.Channel,
		LastCheck:       lastCheck,
		LastCheckResult: s.LastCheckResult,
	})
}

func (s *State) UnmarshalJSON(data []byte) error {
	var raw struct {
		Channel         string          `json:"channel"`
		LastCheck       string          `json:"last_check"`
		LastCheckResult *CheckedUpdate  `json:"last_check_result"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	s.Channel = raw.Channel
	if raw.LastCheck != "" {
		t, err := time.Parse(time.RFC3339, raw.LastCheck)
		if err != nil {
			return fmt.Errorf("upgrader: parse last_check: %w", err)
		}
		s.LastCheck = t
	}
	s.LastCheckResult = raw.LastCheckResult
	return nil
}
