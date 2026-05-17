package wranglercfg

import (
	"bytes"
	"fmt"
	"text/template"
)

// Render expands a wrangler.local template against the supplied inputs.
//
// The template uses Go's text/template syntax with two non-default knobs:
//   - Option("missingkey=error") — referencing an undefined map key or
//     struct field is a hard error, not a silent empty string. This is
//     the explicit motivation for the rewrite: envsubst silently
//     expanded unknown ${VAR} to "" and let typos slip through to live
//     wrangler deploys.
//   - All standard text/template functions are available; we deliberately
//     do not register any custom FuncMap to keep templates inert (no
//     env-reading, no file-loading, no shell-out).
//
// The returned bytes are NOT JSONC-validated here — that's deliberate.
// Render's job is plain string interpolation; the JSONC validity check
// happens inside Merge() when the rendered bytes are parsed by hujson.
// Callers that need an early-fail can call hujson.Parse on the output.
func Render(templateBytes []byte, in *RenderInputs) ([]byte, error) {
	if in == nil {
		return nil, fmt.Errorf("wranglercfg.Render: nil inputs")
	}
	tmpl, err := template.New("wrangler.local").
		Option("missingkey=error").
		Parse(string(templateBytes))
	if err != nil {
		return nil, fmt.Errorf("wranglercfg.Render: parse template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, in); err != nil {
		return nil, fmt.Errorf("wranglercfg.Render: execute template: %w", err)
	}
	return buf.Bytes(), nil
}
