package wranglercfg

import (
	"strings"
	"testing"
)

func TestRender_BasicSubstitution(t *testing.T) {
	t.Parallel()
	in := fullyPopulatedInputs()
	out, err := Render([]byte(`{ "id": "{{ .Account.ID }}" }`), in)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	want := `{ "id": "cf-account-id" }`
	if string(out) != want {
		t.Errorf("Render output mismatch\nwant: %q\ngot:  %q", want, string(out))
	}
}

func TestRender_NestedFields(t *testing.T) {
	t.Parallel()
	in := fullyPopulatedInputs()
	tmpl := `{
  "d1": "{{ .D1.PolarisEmail.ID }}",
  "kv_nonce": "{{ .KV.Nonce.ID }}",
  "host": "https://{{ .Hostnames.PolarisAPI }}",
  "alert_webhook": "{{ .AlertWebhook }}"
}`
	out, err := Render([]byte(tmpl), in)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	got := string(out)
	for _, want := range []string{
		`"d1": "d1-id"`,
		`"kv_nonce": "kv-nonce-id"`,
		`"host": "https://api.example.com"`,
		`"alert_webhook": "https://alerts.example.com/hook"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q in:\n%s", want, got)
		}
	}
}

// The whole point of the rewrite: envsubst silently expanded unknown
// ${VAR} placeholders to empty. text/template with missingkey=error must
// hard-fail instead.
func TestRender_UndefinedFieldIsHardError(t *testing.T) {
	t.Parallel()
	in := fullyPopulatedInputs()
	_, err := Render([]byte(`{ "x": "{{ .Account.NotARealField }}" }`), in)
	if err == nil {
		t.Fatal("Render: want error on undefined field, got nil")
	}
	// Surface the bad path in the error so the operator knows where to
	// look. text/template's own message includes the path on the dot.
	if !strings.Contains(err.Error(), "NotARealField") {
		t.Errorf("error should mention the missing field name, got: %v", err)
	}
}

func TestRender_ParseError(t *testing.T) {
	t.Parallel()
	_, err := Render([]byte(`{{ unterminated`), fullyPopulatedInputs())
	if err == nil {
		t.Fatal("Render: want parse error, got nil")
	}
}

func TestRender_NilInputs(t *testing.T) {
	t.Parallel()
	_, err := Render([]byte(`{}`), nil)
	if err == nil {
		t.Fatal("Render: want error on nil inputs")
	}
}

// Empty template should round-trip to empty bytes. Catches a silly bug
// where Render adds spurious whitespace.
func TestRender_EmptyTemplate(t *testing.T) {
	t.Parallel()
	out, err := Render([]byte(``), fullyPopulatedInputs())
	if err != nil {
		t.Fatalf("Render empty: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("Render empty: want empty bytes, got %q", out)
	}
}

// JSONC comments embedded in the template must pass through unaltered —
// the rewrite's whole point is preserving them.
func TestRender_PreservesComments(t *testing.T) {
	t.Parallel()
	tmpl := `// a header comment
{
  // an inline comment
  "id": "{{ .Account.ID }}"
}
`
	out, err := Render([]byte(tmpl), fullyPopulatedInputs())
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	got := string(out)
	if !strings.Contains(got, "// a header comment") {
		t.Error("header comment lost")
	}
	if !strings.Contains(got, "// an inline comment") {
		t.Error("inline comment lost")
	}
	if !strings.Contains(got, `"id": "cf-account-id"`) {
		t.Errorf("substitution failed: %s", got)
	}
}
