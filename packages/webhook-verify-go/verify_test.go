package polariswebhook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vector struct {
	Name          string `json:"name"`
	Direction     string `json:"direction"`
	Method        string `json:"method"`
	Path          string `json:"path"`
	Query         string `json:"query"`
	Ts            string `json:"ts"`
	Nonce         string `json:"nonce"`
	Secret        string `json:"secret"`
	Body          string `json:"body"`
	ExpectedSig   string `json:"expected_sig"`
	MustVerify    bool   `json:"must_verify"`
	ExpectedError string `json:"expected_error"`
}

func loadVectors(t *testing.T) []vector {
	p, err := filepath.Abs(filepath.Join("..", "test-vectors", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Vectors
}

func TestVectors(t *testing.T) {
	vectors := loadVectors(t)
	for _, v := range vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			r := Verify(Input{
				Direction: Direction(v.Direction),
				Method:    v.Method,
				Path:      v.Path,
				Query:     v.Query,
				Headers: map[string]string{
					"X-Polaris-Ts":    v.Ts,
					"X-Polaris-Nonce": v.Nonce,
					"X-Polaris-Sig":   v.ExpectedSig,
				},
				Body:   []byte(v.Body),
				Secret: []byte(v.Secret),
				Now:    parseTs(v.Ts),
			})
			if v.MustVerify {
				if !r.OK {
					t.Fatalf("expected OK, got code=%s err=%v", r.Code, r.Err)
				}
			} else {
				if r.OK {
					t.Fatalf("expected failure, got OK")
				}
				if v.ExpectedError != "" && string(r.Code) != v.ExpectedError {
					t.Fatalf("expected code %s, got %s", v.ExpectedError, r.Code)
				}
			}
		})
	}
}
