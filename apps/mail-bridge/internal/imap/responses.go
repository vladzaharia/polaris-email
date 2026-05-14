package imap

import (
	"fmt"
	"strings"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
)

// formatEnvelope returns an IMAP ENVELOPE list body (without surrounding
// parens — caller wraps). The order per RFC 9051 §7.5.2 is:
//
//	date subject from sender reply-to to cc bcc in-reply-to message-id
//
// Address fields are themselves parens-lists of (name route mailbox host)
// triples. We only have a single from + multiple to; sender / reply-to
// default to the from list.
func formatEnvelope(r store.MirrorRow) string {
	from := []string{addrList(r.From)}
	to := []string{}
	for _, t := range r.To {
		to = append(to, addrList(t))
	}
	return strings.Join([]string{
		quoteOrNil(r.InternalDate),
		quoteOrNil(r.Subject),
		"(" + strings.Join(from, " ") + ")",
		"(" + strings.Join(from, " ") + ")", // sender
		"(" + strings.Join(from, " ") + ")", // reply-to
		"(" + strings.Join(to, " ") + ")",
		"NIL", // cc
		"NIL", // bcc
		"NIL", // in-reply-to
		quoteOrNil(r.HeaderMessageID),
	}, " ")
}

// addrList renders one RFC 5322 address as an IMAP envelope address.
//
//	(NAME ROUTE MAILBOX HOST)
//
// We pass through the raw address; name/route are NIL.
func addrList(addr string) string {
	at := strings.LastIndex(addr, "@")
	if at < 0 {
		return fmt.Sprintf("(NIL NIL %q NIL)", addr)
	}
	return fmt.Sprintf("(NIL NIL %q %q)", addr[:at], addr[at+1:])
}

func quoteOrNil(s string) string {
	if s == "" {
		return "NIL"
	}
	return fmt.Sprintf("%q", s)
}

// formatBodystructure returns a simplified BODYSTRUCTURE for a one-part
// text/plain message. Real messages with mixed/alternative parts need a
// recursive parse — TODO(production).
func formatBodystructure(r store.MirrorRow) string {
	// Single-part text/plain: TYPE SUBTYPE PARAMS ID DESCRIPTION ENCODING SIZE [LINES]
	return fmt.Sprintf(`"TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" %d 0`, r.SizeBytes)
}
