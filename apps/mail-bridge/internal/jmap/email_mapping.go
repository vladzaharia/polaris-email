package jmap

import (
	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// Email is the RFC 8621 §4 Email object subset the bridge emits.
// We deliberately omit headers/bodyStructure/bodyValues content in this
// skeleton; clients that need raw bodies pull via /jmap/download.
type Email struct {
	ID            string            `json:"id"`
	BlobID        string            `json:"blobId"`
	ThreadID      string            `json:"threadId"`
	MailboxIDs    map[string]bool   `json:"mailboxIds"`
	Keywords      map[string]bool   `json:"keywords"`
	Size          int64             `json:"size"`
	ReceivedAt    string            `json:"receivedAt"`
	SentAt        string            `json:"sentAt,omitempty"`
	From          []EmailAddress    `json:"from,omitempty"`
	To            []EmailAddress    `json:"to,omitempty"`
	CC            []EmailAddress    `json:"cc,omitempty"`
	BCC           []EmailAddress    `json:"bcc,omitempty"`
	Subject       string            `json:"subject,omitempty"`
	Preview       string            `json:"preview,omitempty"`
	HasAttachment bool              `json:"hasAttachment"`
	MessageID     []string          `json:"messageId,omitempty"`
	HeaderRaw     map[string]string `json:"-"` // reserved for /jmap/download payload
}

// EmailAddress mirrors RFC 8621 §4.1.2.3.
type EmailAddress struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email"`
}

// MessageToEmail converts a polaris SDK Message into the JMAP Email shape.
func MessageToEmail(m polarissdk.Message) Email {
	e := Email{
		ID:            m.ID,
		BlobID:        m.ID,
		ThreadID:      m.ThreadID,
		MailboxIDs:    map[string]bool{m.MailboxID: true},
		Keywords:      flagsToKeywords(m.Flags),
		Size:          m.BodyBytes + m.AttachmentsTotalBytes,
		ReceivedAt:    m.ReceivedAtAPI,
		SentAt:        m.CreatedAt,
		Subject:       m.Subject,
		HasAttachment: m.AttachmentsTotalBytes > 0,
	}
	if e.ReceivedAt == "" {
		e.ReceivedAt = m.CreatedAt
	}
	if m.FromAddr != "" {
		e.From = []EmailAddress{{Email: m.FromAddr}}
	}
	for _, t := range m.To {
		e.To = append(e.To, EmailAddress{Email: t})
	}
	if m.HeaderMessageID != "" {
		e.MessageID = []string{m.HeaderMessageID}
	}
	if m.Text != "" {
		preview := m.Text
		if len(preview) > 256 {
			preview = preview[:256]
		}
		e.Preview = preview
	}
	return e
}

// flagsToKeywords maps the polaris flags JSON (\Seen / \Flagged etc.) into
// the JMAP keyword set (RFC 8621 §4.1.1): seen=true, flagged=true, ...
// `\` is dropped; system keywords lowercased; custom keywords pass through.
func flagsToKeywords(flags []string) map[string]bool {
	out := map[string]bool{}
	for _, f := range flags {
		if len(f) > 0 && f[0] == '\\' {
			out["$"+toLowerASCII(f[1:])] = true
		} else {
			out[f] = true
		}
	}
	return out
}

// keywordsToFlags is the inverse — converts a JMAP keywords map into the
// polaris flags JSON shape.
func keywordsToFlags(kw map[string]bool) []string {
	out := []string{}
	for k, v := range kw {
		if !v {
			continue
		}
		if len(k) > 0 && k[0] == '$' {
			out = append(out, "\\"+toTitleASCII(k[1:]))
		} else {
			out = append(out, k)
		}
	}
	return out
}

func toLowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func toTitleASCII(s string) string {
	if s == "" {
		return s
	}
	b := []byte(s)
	if b[0] >= 'a' && b[0] <= 'z' {
		b[0] = b[0] - ('a' - 'A')
	}
	return string(b)
}
