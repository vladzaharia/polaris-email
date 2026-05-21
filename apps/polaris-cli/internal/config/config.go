// Package config loads ~/.config/polaris-mail/config.toml.
//
// The file format is intentionally simple — a custom TOML-subset parser is
// used so this module has zero third-party dependencies.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// File represents the on-disk config file.
type File struct {
	Profiles map[string]Profile
	Default  string
}

// Profile is one set of admin credentials.
type Profile struct {
	APIURL    string
	Token     string
	KeyID     string
	AccountID string
}

// DefaultPath returns the canonical config-file location.
func DefaultPath() (string, error) {
	if v := os.Getenv("POLARIS_CONFIG"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "polaris-mail", "config.toml"), nil
}

// Load reads the config file at path. A missing file returns an empty
// File. If the file exists, we require permissions of 0600 (owner-only)
// — the config holds API tokens, and a world-readable file is a real
// foot-gun for shared dev hosts.
func Load(path string) (*File, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &File{Profiles: map[string]Profile{}}, nil
		}
		return nil, err
	}
	// Skip the permission check on Windows (mode bits don't carry the
	// same meaning). On POSIX, refuse anything broader than 0600.
	if mode := info.Mode().Perm(); mode != 0 && (mode&0o077) != 0 {
		return nil, fmt.Errorf(
			"polaris-mail config %s has permissions %o; require 0600 "+
				"(run: chmod 600 %s)",
			path, mode, path,
		)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(string(data))
}

// Parse parses a minimal TOML subset:
//
//	default = "prod"
//	[profiles.prod]
//	api_url = "..."
//	token = "..."
//	key_id = "..."
//	account_id = "..."
func Parse(src string) (*File, error) {
	f := &File{Profiles: map[string]Profile{}}
	var section, profileName string
	for lineNo, raw := range strings.Split(src, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			hdr := strings.TrimSpace(line[1 : len(line)-1])
			parts := strings.SplitN(hdr, ".", 2)
			section = parts[0]
			profileName = ""
			if section == "profiles" && len(parts) == 2 {
				profileName = parts[1]
				if _, ok := f.Profiles[profileName]; !ok {
					f.Profiles[profileName] = Profile{}
				}
			}
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			return nil, fmt.Errorf("config:%d: missing '=' in %q", lineNo+1, line)
		}
		k := strings.TrimSpace(line[:eq])
		v := strings.TrimSpace(line[eq+1:])
		v = strings.TrimSpace(strings.SplitN(v, "#", 2)[0])
		v = strings.Trim(v, "\"'")

		if section == "" || section == "global" {
			if k == "default" {
				f.Default = v
			}
			continue
		}
		if section == "profiles" && profileName != "" {
			p := f.Profiles[profileName]
			switch k {
			case "api_url":
				p.APIURL = v
			case "token":
				p.Token = v
			case "key_id":
				p.KeyID = v
			case "account_id":
				p.AccountID = v
			}
			f.Profiles[profileName] = p
		}
	}
	if f.Default == "" {
		if _, ok := f.Profiles["prod"]; ok {
			f.Default = "prod"
		}
	}
	return f, nil
}

// Resolve returns the named profile (or the default profile when name=="").
func (f *File) Resolve(name string) (Profile, error) {
	if name == "" {
		name = f.Default
	}
	if name == "" {
		name = "prod"
	}
	p, ok := f.Profiles[name]
	if !ok {
		return Profile{}, fmt.Errorf("config: profile %q not found", name)
	}
	return p, nil
}
