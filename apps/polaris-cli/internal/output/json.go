package output

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"
	"time"
)

// EmitJSON writes v as pretty-printed JSON.
func EmitJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// EmitYAML writes v as a tiny-subset YAML document. We round-trip via
// encoding/json to get a normalized any-tree, then emit it with deterministic
// key ordering. This avoids a third-party yaml dependency for output rendering
// (the wizard --from-file loader handles full YAML separately if needed).
func EmitYAML(w io.Writer, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		return err
	}
	return writeYAML(w, tree, 0)
}

func writeYAML(w io.Writer, v any, indent int) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			val := t[k]
			if isCompound(val) {
				fmt.Fprintf(w, "%s%s:\n", pad(indent), k)
				if err := writeYAML(w, val, indent+1); err != nil {
					return err
				}
			} else {
				fmt.Fprintf(w, "%s%s: %s\n", pad(indent), k, scalar(val))
			}
		}
	case []any:
		if len(t) == 0 {
			fmt.Fprintf(w, "%s[]\n", pad(indent))
			return nil
		}
		for _, el := range t {
			if isCompound(el) {
				fmt.Fprintf(w, "%s-\n", pad(indent))
				if err := writeYAML(w, el, indent+1); err != nil {
					return err
				}
			} else {
				fmt.Fprintf(w, "%s- %s\n", pad(indent), scalar(el))
			}
		}
	default:
		fmt.Fprintf(w, "%s%s\n", pad(indent), scalar(v))
	}
	return nil
}

func isCompound(v any) bool {
	if v == nil {
		return false
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Map, reflect.Slice, reflect.Array:
		return rv.Len() > 0
	}
	return false
}

func scalar(v any) string {
	if v == nil {
		return "null"
	}
	switch t := v.(type) {
	case string:
		// Quote when string contains characters that confuse YAML scanners.
		if needsYAMLQuote(t) {
			return strconvQuote(t)
		}
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		// JSON numbers always come back as float64; emit ints without decimal.
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%g", t)
	case time.Time:
		return t.Format(time.RFC3339)
	}
	return fmt.Sprintf("%v", v)
}

func needsYAMLQuote(s string) bool {
	if s == "" {
		return true
	}
	if strings.ContainsAny(s, ":#\n\"'\t") {
		return true
	}
	// Reserved scalars
	switch strings.ToLower(s) {
	case "true", "false", "null", "yes", "no", "on", "off", "~":
		return true
	}
	return false
}

func strconvQuote(s string) string {
	// Minimal JSON-compatible quoting: backslash escape \" and \\.
	r := strings.ReplaceAll(s, `\`, `\\`)
	r = strings.ReplaceAll(r, `"`, `\"`)
	r = strings.ReplaceAll(r, "\n", `\n`)
	return `"` + r + `"`
}

func pad(n int) string { return strings.Repeat("  ", n) }
