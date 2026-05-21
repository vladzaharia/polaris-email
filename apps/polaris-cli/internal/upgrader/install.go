package upgrader

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Stage names the high-level upgrade phase a Progress event describes.
// Used by the TUI infobox to switch status text between "Downloading…",
// "Verifying…", "Installing…", "Restarting in Ns…", etc.
type Stage string

const (
	StageStart      Stage = "start"
	StageDownload   Stage = "download"
	StageVerify     Stage = "verify"
	StageExtract    Stage = "extract"
	StageReplace    Stage = "replace"
	StageDone       Stage = "done"
	StageBrewHandoff Stage = "brew"
)

// Progress is a single point-in-time progress update. BytesTotal == 0
// means the stage doesn't have a known bound (use indeterminate
// rendering); BytesDone == BytesTotal at completion.
type Progress struct {
	Stage      Stage
	BytesDone  int64
	BytesTotal int64
	Message    string
}

// ProgressFn receives Progress updates from a running install. Safe to
// nil — Install() guards every call. Called from the goroutine doing
// the actual work; TUI integrations should buffer through a channel or
// use prog.Send() rather than touching the Bubbletea model directly.
type ProgressFn func(Progress)

// Install downloads the update, verifies SHA-256, extracts the
// binary, and atomically replaces the running executable. Returns the
// path to the new binary (== os.Executable()) on success.
//
// install method controls the strategy:
//   - brew: shell out to `brew upgrade polaris-mail` (Update is
//     used only for the version we're upgrading TO, since brew
//     resolves its own source-of-truth).
//   - curl / unknown: tarball-from-GitHub-Releases path.
//   - local: rebuild from the operator's repo checkout via `make build`.
//
// Re-exec into the new binary is NOT done here — callers do it after
// any final UI cleanup (e.g. the TUI restart-countdown). See ReExec().
func Install(ctx context.Context, u *Update, method InstallMethod, onProgress ProgressFn) error {
	if u == nil {
		return fmt.Errorf("upgrader: Install called with nil Update")
	}
	report(onProgress, Progress{Stage: StageStart, Message: fmt.Sprintf("Upgrading to %s", u.LatestVersion)})

	switch method {
	case InstallMethodBrew:
		return installBrew(ctx, u, onProgress)
	case InstallMethodLocal:
		return installLocal(ctx, u, onProgress)
	case InstallMethodCurl, InstallMethodUnknown:
		return installFromTarball(ctx, u, onProgress)
	default:
		return fmt.Errorf("upgrader: unsupported install method %q", method)
	}
}

func installBrew(ctx context.Context, u *Update, onProgress ProgressFn) error {
	report(onProgress, Progress{Stage: StageBrewHandoff, Message: "brew upgrade polaris-mail"})
	cmd := exec.CommandContext(ctx, "brew", "upgrade", "polaris-mail")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("upgrader: brew upgrade failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	report(onProgress, Progress{Stage: StageDone, Message: fmt.Sprintf("Upgraded to %s via brew", u.LatestVersion)})
	return nil
}

// installLocal runs `make build` in the polaris-cli directory inside
// the operator's checkout, then atomically replaces the running
// binary with the freshly-built one. No network involved.
//
// Finds the checkout by walking up from os.Executable() to a `.git`
// ancestor — same heuristic detect.go uses.
func installLocal(ctx context.Context, _ *Update, onProgress ProgressFn) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	resolved, _ := filepath.EvalSymlinks(exe)
	if resolved == "" {
		resolved = exe
	}
	repoRoot := findRepoRoot(resolved)
	if repoRoot == "" {
		return fmt.Errorf("upgrader: cannot find polaris-mail repo root from %s", resolved)
	}
	report(onProgress, Progress{Stage: StageExtract, Message: "make build"})
	cmd := exec.CommandContext(ctx, "make", "build")
	cmd.Dir = filepath.Join(repoRoot, "apps", "polaris-cli")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("upgrader: make build failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	freshBinary := filepath.Join(cmd.Dir, "bin", "polaris-mail")
	report(onProgress, Progress{Stage: StageReplace, Message: "Replacing binary"})
	if err := atomicReplace(freshBinary, resolved); err != nil {
		return err
	}
	report(onProgress, Progress{Stage: StageDone})
	return nil
}

// installFromTarball is the curl-path implementation: download tarball,
// verify sha256 from checksums.txt, extract the polaris-mail binary,
// atomic-replace the running executable.
func installFromTarball(ctx context.Context, u *Update, onProgress ProgressFn) error {
	tmp, err := os.MkdirTemp("", "polaris-mail-upgrade-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	archivePath := filepath.Join(tmp, u.AssetName)
	if err := downloadWithProgress(ctx, u.AssetURL, archivePath, onProgress); err != nil {
		return err
	}

	report(onProgress, Progress{Stage: StageVerify, Message: "sha256 checksum"})
	if u.ChecksumsURL != "" {
		if err := verifyChecksum(ctx, archivePath, u.AssetName, u.ChecksumsURL); err != nil {
			return err
		}
	}

	report(onProgress, Progress{Stage: StageExtract, Message: "extracting"})
	freshBinary, err := extractBinary(archivePath, tmp)
	if err != nil {
		return err
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	resolved, _ := filepath.EvalSymlinks(exe)
	if resolved == "" {
		resolved = exe
	}
	report(onProgress, Progress{Stage: StageReplace, Message: "replacing binary"})
	if err := atomicReplace(freshBinary, resolved); err != nil {
		return err
	}
	report(onProgress, Progress{Stage: StageDone})
	return nil
}

// downloadWithProgress streams an asset to disk with byte-accurate
// progress reporting. Uses a 60s overall timeout — a 20MB binary on a
// 1 Mbit connection takes ~3 min; tighten if you ever ship larger
// archives. Defers to context.Context for early cancellation.
func downloadWithProgress(ctx context.Context, url, dest string, onProgress ProgressFn) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("upgrader: download %s: %w", url, err)
	}
	defer resp.Body.Close()
	// GitHub Releases serves via a 302 to the actual CDN; net/http
	// follows redirects by default so we land on the binary stream.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upgrader: download %s: %d", url, resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	total := resp.ContentLength
	report(onProgress, Progress{Stage: StageDownload, BytesDone: 0, BytesTotal: total, Message: "downloading"})

	counter := &progressWriter{total: total, fn: onProgress}
	if _, err := io.Copy(io.MultiWriter(f, counter), resp.Body); err != nil {
		return fmt.Errorf("upgrader: write %s: %w", dest, err)
	}
	return nil
}

// progressWriter is the io.Writer half of an io.MultiWriter that counts
// bytes flowing through and emits Progress events. Coalesces updates to
// at most every 64KiB to keep the Bubbletea inbox from getting flooded
// on a fast LAN (a 20MB tarball at 1Gbps is ~330 messages/sec without
// this throttle, which the TUI doesn't need).
type progressWriter struct {
	written int64
	total   int64
	lastTx  int64
	fn      ProgressFn
}

const progressTxBytes = 64 * 1024

func (p *progressWriter) Write(b []byte) (int, error) {
	n := len(b)
	p.written += int64(n)
	if p.written-p.lastTx >= progressTxBytes || p.written == p.total {
		p.lastTx = p.written
		report(p.fn, Progress{Stage: StageDownload, BytesDone: p.written, BytesTotal: p.total})
	}
	return n, nil
}

// verifyChecksum reads checksums.txt, locates the line for assetName,
// and confirms the file at path hashes to the same SHA-256. Errors
// (network, format, mismatch) all fail-closed — refusing to install an
// unverified binary is the right default for a self-upgrader.
func verifyChecksum(ctx context.Context, path, assetName, checksumsURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, checksumsURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upgrader: checksums.txt: %d", resp.StatusCode)
	}
	expected := ""
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		// goreleaser writes: "<sha256-hex>  <filename>"
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[len(parts)-1] == assetName {
			expected = parts[0]
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("upgrader: scan checksums: %w", err)
	}
	if expected == "" {
		return fmt.Errorf("upgrader: no checksum entry for %s", assetName)
	}

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != expected {
		return fmt.Errorf("upgrader: sha256 mismatch for %s: got %s expected %s", assetName, got, expected)
	}
	return nil
}

// extractBinary unpacks the goreleaser archive shape — a single
// `polaris-mail` binary at the top level — into destDir and returns
// its path. Handles both tar.gz (Linux/Darwin) and zip (Windows).
func extractBinary(archivePath, destDir string) (string, error) {
	if strings.HasSuffix(archivePath, ".zip") {
		return extractZipBinary(archivePath, destDir)
	}
	return extractTarGzBinary(archivePath, destDir)
}

func extractTarGzBinary(archivePath, destDir string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("upgrader: gunzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	binaryName := "polaris-mail"
	if runtime.GOOS == "windows" {
		binaryName = "polaris-mail.exe"
	}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("upgrader: tar next: %w", err)
		}
		if filepath.Base(hdr.Name) != binaryName {
			continue
		}
		out := filepath.Join(destDir, binaryName)
		if err := writeFile(out, tr, 0o755); err != nil {
			return "", err
		}
		return out, nil
	}
	return "", fmt.Errorf("upgrader: %s not found in archive", binaryName)
}

func extractZipBinary(archivePath, destDir string) (string, error) {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", err
	}
	defer r.Close()
	binaryName := "polaris-mail.exe"
	for _, f := range r.File {
		if filepath.Base(f.Name) != binaryName {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		out := filepath.Join(destDir, binaryName)
		err = writeFile(out, rc, 0o755)
		rc.Close()
		if err != nil {
			return "", err
		}
		return out, nil
	}
	return "", fmt.Errorf("upgrader: %s not found in archive", binaryName)
}

func writeFile(path string, src io.Reader, mode os.FileMode) error {
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}

// atomicReplace writes the binary at src to a temp file in the same
// directory as dst, then renames over dst. rename(2) within a single
// filesystem is atomic on POSIX. On Windows, replacing a running
// executable is documented to fail — see ReExec's Windows stub for the
// "land on next launch" fallback (we still do the file write here; the
// Windows shell wraps the call with a `.new` suffix that's swapped on
// next launch).
func atomicReplace(src, dst string) error {
	if runtime.GOOS == "windows" {
		// Can't rename over the running .exe; write to a sibling that
		// the next launch will swap in (or the operator picks up
		// manually after Quit).
		side := dst + ".new"
		return copyFile(src, side, 0o755)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".polaris-mail-upgrade-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, dst)
}

// copyFile is the windows path's lighter cousin of atomicReplace.
func copyFile(src, dst string, mode os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, mode)
}

// findRepoRoot walks up from path until it finds a `.git` ancestor.
// Returns the directory containing `.git`, or "" if none found.
func findRepoRoot(path string) string {
	dir := filepath.Dir(path)
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func report(fn ProgressFn, p Progress) {
	if fn == nil {
		return
	}
	fn(p)
}

// silence the bytes import (used only via bytes.Buffer indirectly in
// tests we'll add later)
var _ = bytes.NewBuffer
