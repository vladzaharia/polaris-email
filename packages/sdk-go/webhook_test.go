package polarissdk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

type vector struct {
	Name          string `json:"name"`
	Direction     string `json:"direction"`
	Method        string `json:"method"`
	Path          string `json:"path"`
	Query         string `json:"query"`
	TS            string `json:"ts"`
	Nonce         string `json:"nonce"`
	Secret        string `json:"secret"`
	Body          string `json:"body"`
	ExpectedSig   string `json:"expected_sig"`
	MustVerify    bool   `json:"must_verify"`
	ExpectedError string `json:"expected_error"`
}

type vectorsFile struct {
	Vectors []vector `json:"vectors"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(here), "..", "test-vectors", "vectors.json")
	data, err := os.ReadFile(root)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f vectorsFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return f.Vectors
}

func TestVerifyAgainstSharedVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			tsMs, _ := strconv.ParseInt(v.TS, 10, 64)
			res := VerifyWebhook(VerifyInput{
				Direction: Direction(v.Direction),
				Method:    v.Method,
				Path:      v.Path,
				Query:     v.Query,
				Headers: map[string]string{
					"x-polaris-ts":    v.TS,
					"x-polaris-nonce": v.Nonce,
					"x-polaris-sig":   v.ExpectedSig,
				},
				Body:   []byte(v.Body),
				Secret: []byte(v.Secret),
				Now:    time.UnixMilli(tsMs),
			})
			if v.MustVerify && !res.OK {
				t.Fatalf("expected ok: %+v", res)
			}
			if !v.MustVerify && res.OK {
				t.Fatalf("expected fail: %+v", res)
			}
		})
	}
}

func TestRejectsVersionedSignaturePrefix(t *testing.T) {
	vs := loadVectors(t)
	var v vector
	for _, x := range vs {
		if x.MustVerify {
			v = x
			break
		}
	}
	// Prefix the otherwise-valid signature with `v1=` — must be rejected.
	prefixed := "v1=" + v.ExpectedSig
	tsMs, _ := strconv.ParseInt(v.TS, 10, 64)
	res := VerifyWebhook(VerifyInput{
		Direction: Direction(v.Direction),
		Method:    v.Method,
		Path:      v.Path,
		Query:     v.Query,
		Headers: map[string]string{
			"x-polaris-ts":    v.TS,
			"x-polaris-nonce": v.Nonce,
			"x-polaris-sig":   prefixed,
		},
		Body:   []byte(v.Body),
		Secret: []byte(v.Secret),
		Now:    time.UnixMilli(tsMs),
	})
	if res.OK {
		t.Fatalf("expected fail for prefixed sig, got: %+v", res)
	}
	if res.Code != CodeInvalidSignature {
		t.Fatalf("expected code=invalid_signature, got %s", res.Code)
	}
}
