// Package output renders command results as tables, JSON, or YAML.
//
// All renderers depend only on the standard library so the CLI has zero
// third-party transitive deps for output rendering.
package output

import (
	"fmt"
	"io"
	"strings"
)

// Format selects an output renderer.
type Format string

const (
	FormatTable Format = "table"
	FormatJSON  Format = "json"
	FormatYAML  Format = "yaml"
)

// ParseFormat normalizes a CLI flag value to a Format. Empty defaults to table.
func ParseFormat(s string) (Format, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "table":
		return FormatTable, nil
	case "json":
		return FormatJSON, nil
	case "yaml", "yml":
		return FormatYAML, nil
	default:
		return "", fmt.Errorf("unknown output format %q (want table|json|yaml)", s)
	}
}

// Table is a simple column-aligned text table.
type Table struct {
	Headers []string
	Rows    [][]string
}

// Render writes the table to w with two-space column padding.
func (t *Table) Render(w io.Writer) error {
	cols := len(t.Headers)
	widths := make([]int, cols)
	for i, h := range t.Headers {
		widths[i] = visibleLen(h)
	}
	for _, row := range t.Rows {
		for i, cell := range row {
			if i >= cols {
				continue
			}
			if l := visibleLen(cell); l > widths[i] {
				widths[i] = l
			}
		}
	}
	writeRow(w, t.Headers, widths)
	sep := make([]string, cols)
	for i, wd := range widths {
		sep[i] = strings.Repeat("-", wd)
	}
	writeRow(w, sep, widths)
	for _, row := range t.Rows {
		// pad short rows so columns align
		full := make([]string, cols)
		for i := 0; i < cols; i++ {
			if i < len(row) {
				full[i] = row[i]
			}
		}
		writeRow(w, full, widths)
	}
	return nil
}

func writeRow(w io.Writer, row []string, widths []int) {
	parts := make([]string, len(row))
	for i, cell := range row {
		pad := widths[i] - visibleLen(cell)
		if pad < 0 {
			pad = 0
		}
		parts[i] = sanitize(cell) + strings.Repeat(" ", pad)
	}
	fmt.Fprintln(w, strings.Join(parts, "  "))
}

// visibleLen counts runes, ignoring ANSI escape sequences (we strip them
// anyway in sanitize, so this is just the rune count of the input).
func visibleLen(s string) int {
	n := 0
	skipping := false
	for _, r := range s {
		if r == 0x1b {
			skipping = true
			continue
		}
		if skipping {
			if r == 'm' {
				skipping = false
			}
			continue
		}
		n++
	}
	return n
}

// sanitize strips ANSI escape sequences to defend against subject-line
// injection in TUI/table renderings (mitigation for the Medium finding noted
// in the plan's security audit).
func sanitize(s string) string {
	var sb strings.Builder
	skipping := false
	for _, r := range s {
		if r == 0x1b {
			skipping = true
			continue
		}
		if skipping {
			if r == 'm' {
				skipping = false
			}
			continue
		}
		if r < 0x20 && r != '\t' {
			sb.WriteByte(' ')
			continue
		}
		sb.WriteRune(r)
	}
	return sb.String()
}
