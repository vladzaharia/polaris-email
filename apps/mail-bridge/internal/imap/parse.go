package imap

import (
	"strconv"
	"strings"
	"unicode"
)

// parseCommand splits an IMAP wire line into (tag, command, args).
//
// IMAP commands look like:  A001 LOGIN "alice" "secret"
//
//	A002 FETCH 1:* (UID FLAGS)
//
// We split on whitespace at the top level but preserve quoted strings and
// parenthesised lists verbatim.
func parseCommand(line string) (tag, cmd string, args []string) {
	toks := tokenize(line)
	if len(toks) < 2 {
		return "", "", nil
	}
	tag = toks[0]
	cmd = strings.ToUpper(toks[1])
	args = toks[2:]
	return
}

// tokenize splits a wire line into top-level tokens, keeping quoted strings
// ("foo bar") and parenthesised lists ((UID FLAGS)) as single tokens.
func tokenize(line string) []string {
	var out []string
	var b strings.Builder
	depth := 0
	inQuote := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case inQuote:
			b.WriteByte(c)
			if c == '"' && (i == 0 || line[i-1] != '\\') {
				inQuote = false
			}
		case c == '"':
			b.WriteByte(c)
			inQuote = true
		case c == '(':
			depth++
			b.WriteByte(c)
		case c == ')':
			depth--
			b.WriteByte(c)
		case unicode.IsSpace(rune(c)) && depth == 0:
			if b.Len() > 0 {
				out = append(out, b.String())
				b.Reset()
			}
		default:
			b.WriteByte(c)
		}
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

// unquote strips a leading and trailing " from a token. If absent, returns
// the token unchanged.
func unquote(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}

// parens strips ( and ) from a token like "(UID FLAGS)" and returns the
// inner tokens.
func parens(s string) []string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '(' && s[len(s)-1] == ')' {
		s = s[1 : len(s)-1]
	}
	return strings.Fields(s)
}

// parseSeqSet expands "1:5" / "1,3:5" / "*" / "1:*" into a slice of (lo,hi)
// pairs. The caller maps these to UIDs or sequence numbers depending on the
// command variant (FETCH vs UID FETCH).
func parseSeqSet(s string) [][2]int {
	out := [][2]int{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, ":") {
			ab := strings.SplitN(part, ":", 2)
			lo := toIntOrStar(ab[0], 1)
			hi := toIntOrStar(ab[1], -1)
			out = append(out, [2]int{lo, hi})
		} else {
			n := toIntOrStar(part, -1)
			out = append(out, [2]int{n, n})
		}
	}
	return out
}

func toIntOrStar(s string, fallback int) int {
	s = strings.TrimSpace(s)
	if s == "*" {
		return -1 // sentinel for "max"
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return n
}
