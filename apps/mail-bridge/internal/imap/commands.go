package imap

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
)

// dispatch routes one parsed IMAP command to its handler. Returns a hard
// error only when the connection should be torn down (write failed, etc.).
// Protocol-level NO/BAD are handled within each handler.
func (s *session) dispatch(ctx context.Context, tag, cmd string, args []string) error {
	switch cmd {
	case "CAPABILITY":
		if err := s.untagged("CAPABILITY IMAP4rev1 IMAP4rev2 AUTH=PLAIN IDLE CONDSTORE"); err != nil {
			return err
		}
		return s.taggedOK(tag, "CAPABILITY completed")
	case "NOOP":
		return s.taggedOK(tag, "NOOP completed")
	case "LOGIN":
		return s.cmdLogin(ctx, tag, args)
	case "LOGOUT":
		_ = s.untagged("BYE polaris-mail-bridge logging out")
		if err := s.taggedOK(tag, "LOGOUT completed"); err != nil {
			return err
		}
		s.authState = "logout"
		return nil
	case "LIST":
		return s.cmdList(tag, args)
	case "LSUB":
		// We don't ship subscriptions (INBOX-only). Respond as if no subs.
		return s.taggedOK(tag, "LSUB completed")
	case "SELECT", "EXAMINE":
		return s.cmdSelect(ctx, tag, args, cmd == "EXAMINE")
	case "STATUS":
		return s.cmdStatus(ctx, tag, args)
	case "FETCH":
		return s.cmdFetch(ctx, tag, args, false)
	case "UID":
		return s.cmdUid(ctx, tag, args)
	case "STORE":
		return s.cmdStore(ctx, tag, args, false)
	case "EXPUNGE":
		return s.cmdExpunge(ctx, tag)
	case "CLOSE":
		return s.cmdClose(ctx, tag)
	case "IDLE":
		return s.cmdIdle(ctx, tag)
	case "SEARCH":
		// TODO(production): wire to GET /v1/messages?q=... with header/flag filters.
		return s.taggedOK(tag, "SEARCH completed (no results — TODO production)")
	default:
		return s.taggedBAD(tag, fmt.Sprintf("unknown or unsupported command: %s", cmd))
	}
}

func (s *session) cmdLogin(ctx context.Context, tag string, args []string) error {
	if len(args) < 2 {
		return s.taggedBAD(tag, "LOGIN requires user + pass")
	}
	user := unquote(args[0])
	pass := unquote(args[1])
	mailboxID, err := authenticate(ctx, s.deps.Client, user, pass)
	if err != nil {
		return s.taggedNO(tag, "LOGIN failed: "+err.Error())
	}
	s.mailboxID = mailboxID
	s.username = user
	s.authState = "authenticated"
	return s.taggedOK(tag, "LOGIN completed")
}

func (s *session) cmdList(tag string, args []string) error {
	if s.authState == "unauthenticated" {
		return s.taggedNO(tag, "LIST requires authentication")
	}
	// INBOX-only. RFC 9051: LIST "" "*"  → all hierarchies; LIST "" "INBOX" → just INBOX.
	if err := s.untagged(`LIST (\HasNoChildren) "/" INBOX`); err != nil {
		return err
	}
	return s.taggedOK(tag, "LIST completed")
}

func (s *session) cmdSelect(ctx context.Context, tag string, args []string, readOnly bool) error {
	if s.authState == "unauthenticated" {
		return s.taggedNO(tag, "SELECT requires authentication")
	}
	if len(args) < 1 {
		return s.taggedBAD(tag, "SELECT requires mailbox name")
	}
	name := unquote(args[0])
	if !strings.EqualFold(name, "INBOX") {
		return s.taggedNO(tag, "no such mailbox (only INBOX is supported)")
	}
	st, err := s.deps.Mirror.MailboxState(ctx, s.mailboxID)
	if err != nil {
		return s.taggedNO(tag, "mirror lookup failed: "+err.Error())
	}
	_ = s.untagged(fmt.Sprintf("%d EXISTS", st.Total))
	_ = s.untagged("0 RECENT")
	_ = s.untagged(`FLAGS (\Seen \Answered \Flagged \Deleted)`)
	_ = s.untagged(`OK [PERMANENTFLAGS (\Seen \Answered \Flagged \Deleted \*)] permanent flags ok`)
	_ = s.untagged(fmt.Sprintf("OK [UIDVALIDITY %d] UID validity", st.UIDValidity))
	_ = s.untagged(fmt.Sprintf("OK [UIDNEXT %d] UID next", st.NextUID))
	_ = s.untagged(fmt.Sprintf("OK [HIGHESTMODSEQ %d] CONDSTORE", st.HighestModseq))
	s.authState = "selected"
	s.selectedRO = readOnly
	suffix := "READ-WRITE"
	if readOnly {
		suffix = "READ-ONLY"
	}
	return s.taggedOK(tag, fmt.Sprintf("[%s] %s completed", suffix, map[bool]string{true: "EXAMINE", false: "SELECT"}[readOnly]))
}

func (s *session) cmdStatus(ctx context.Context, tag string, args []string) error {
	if s.authState == "unauthenticated" {
		return s.taggedNO(tag, "STATUS requires authentication")
	}
	if len(args) < 2 {
		return s.taggedBAD(tag, "STATUS requires mailbox + items")
	}
	name := unquote(args[0])
	if !strings.EqualFold(name, "INBOX") {
		return s.taggedNO(tag, "no such mailbox")
	}
	st, err := s.deps.Mirror.MailboxState(ctx, s.mailboxID)
	if err != nil {
		return s.taggedNO(tag, "mirror lookup failed: "+err.Error())
	}
	items := parens(args[1])
	parts := []string{}
	for _, k := range items {
		switch strings.ToUpper(k) {
		case "MESSAGES":
			parts = append(parts, fmt.Sprintf("MESSAGES %d", st.Total))
		case "UIDNEXT":
			parts = append(parts, fmt.Sprintf("UIDNEXT %d", st.NextUID))
		case "UIDVALIDITY":
			parts = append(parts, fmt.Sprintf("UIDVALIDITY %d", st.UIDValidity))
		case "UNSEEN":
			parts = append(parts, fmt.Sprintf("UNSEEN %d", st.Unseen))
		case "HIGHESTMODSEQ":
			parts = append(parts, fmt.Sprintf("HIGHESTMODSEQ %d", st.HighestModseq))
		}
	}
	if err := s.untagged(fmt.Sprintf("STATUS INBOX (%s)", strings.Join(parts, " "))); err != nil {
		return err
	}
	return s.taggedOK(tag, "STATUS completed")
}

func (s *session) cmdFetch(ctx context.Context, tag string, args []string, byUID bool) error {
	if s.authState != "selected" {
		return s.taggedNO(tag, "FETCH requires a selected mailbox")
	}
	if len(args) < 2 {
		return s.taggedBAD(tag, "FETCH requires sequence-set + items")
	}
	set := parseSeqSet(args[0])
	items := parens(args[1])
	rows, err := s.deps.Mirror.ListMessages(ctx, s.mailboxID, byUID, set)
	if err != nil {
		return s.taggedNO(tag, "fetch failed: "+err.Error())
	}
	for _, r := range rows {
		bits := []string{}
		for _, item := range items {
			switch strings.ToUpper(item) {
			case "UID":
				bits = append(bits, fmt.Sprintf("UID %d", r.UID))
			case "FLAGS":
				bits = append(bits, "FLAGS ("+strings.Join(r.Flags, " ")+")")
			case "RFC822.SIZE":
				bits = append(bits, fmt.Sprintf("RFC822.SIZE %d", r.SizeBytes))
			case "INTERNALDATE":
				bits = append(bits, fmt.Sprintf("INTERNALDATE %q", r.InternalDate))
			case "ENVELOPE":
				bits = append(bits, fmt.Sprintf("ENVELOPE (%s)", formatEnvelope(r)))
			case "BODYSTRUCTURE":
				bits = append(bits, fmt.Sprintf("BODYSTRUCTURE (%s)", formatBodystructure(r)))
			default:
				// TODO(production): BODY[1], BODY[HEADER], BODY[TEXT], etc.
				bits = append(bits, fmt.Sprintf("%s NIL", strings.ToUpper(item)))
			}
		}
		_ = s.untagged(fmt.Sprintf("%d FETCH (%s)", r.Seq, strings.Join(bits, " ")))
	}
	return s.taggedOK(tag, "FETCH completed")
}

func (s *session) cmdUid(ctx context.Context, tag string, args []string) error {
	if len(args) < 2 {
		return s.taggedBAD(tag, "UID requires subcommand + args")
	}
	sub := strings.ToUpper(args[0])
	rest := args[1:]
	switch sub {
	case "FETCH":
		return s.cmdFetch(ctx, tag, rest, true)
	case "STORE":
		return s.cmdStore(ctx, tag, rest, true)
	case "SEARCH":
		return s.taggedOK(tag, "UID SEARCH completed (no results — TODO production)")
	default:
		return s.taggedBAD(tag, "UID subcommand not supported: "+sub)
	}
}

func (s *session) cmdStore(ctx context.Context, tag string, args []string, byUID bool) error {
	if s.authState != "selected" || s.selectedRO {
		return s.taggedNO(tag, "STORE requires read-write selection")
	}
	if len(args) < 3 {
		return s.taggedBAD(tag, "STORE requires sequence-set + op + flag-list")
	}
	set := parseSeqSet(args[0])
	op := strings.ToUpper(args[1]) // FLAGS / +FLAGS / -FLAGS (optionally .SILENT)
	rows, err := s.deps.Mirror.ListMessages(ctx, s.mailboxID, byUID, set)
	if err != nil {
		return s.taggedNO(tag, "lookup failed: "+err.Error())
	}
	newFlags := parens(args[2])
	silent := strings.HasSuffix(op, ".SILENT")
	op = strings.TrimSuffix(op, ".SILENT")
	for _, r := range rows {
		flags := mergeFlags(op, r.Flags, newFlags)
		updated, err := s.deps.Client.PatchMessageFlags(ctx, r.MessageID, flags)
		if err != nil {
			_ = s.untagged(fmt.Sprintf("%d NO STORE failed: %v", r.Seq, err))
			continue
		}
		if !silent {
			_ = s.untagged(fmt.Sprintf("%d FETCH (FLAGS (%s))", r.Seq, strings.Join(updated.Flags, " ")))
		}
		_ = s.deps.Mirror.UpdateFlags(ctx, s.mailboxID, r.MessageID, updated.Flags)
	}
	return s.taggedOK(tag, "STORE completed")
}

func (s *session) cmdExpunge(ctx context.Context, tag string) error {
	if s.authState != "selected" || s.selectedRO {
		return s.taggedNO(tag, "EXPUNGE requires read-write selection")
	}
	rows, err := s.deps.Mirror.ListMessages(ctx, s.mailboxID, false, [][2]int{{1, -1}})
	if err != nil {
		return s.taggedNO(tag, "expunge lookup failed: "+err.Error())
	}
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if !containsFlag(r.Flags, `\Deleted`) {
			continue
		}
		if err := s.deps.Client.DeleteMessage(ctx, r.MessageID); err != nil {
			_ = s.untagged(fmt.Sprintf("%d NO EXPUNGE failed: %v", r.Seq, err))
			continue
		}
		_ = s.untagged(fmt.Sprintf("%d EXPUNGE", r.Seq))
		_ = s.deps.Mirror.MarkExpunged(ctx, s.mailboxID, r.MessageID)
	}
	return s.taggedOK(tag, "EXPUNGE completed")
}

func (s *session) cmdClose(ctx context.Context, tag string) error {
	if s.authState != "selected" {
		return s.taggedNO(tag, "CLOSE requires a selected mailbox")
	}
	// CLOSE silently expunges and returns to AUTHENTICATED.
	rows, _ := s.deps.Mirror.ListMessages(ctx, s.mailboxID, false, [][2]int{{1, -1}})
	for _, r := range rows {
		if containsFlag(r.Flags, `\Deleted`) {
			_ = s.deps.Client.DeleteMessage(ctx, r.MessageID)
			_ = s.deps.Mirror.MarkExpunged(ctx, s.mailboxID, r.MessageID)
		}
	}
	s.authState = "authenticated"
	return s.taggedOK(tag, "CLOSE completed")
}

func (s *session) cmdIdle(ctx context.Context, tag string) error {
	if s.authState != "selected" {
		return s.taggedNO(tag, "IDLE requires a selected mailbox")
	}
	_ = s.writeLine("+ idling")

	existsFn := func() int {
		st, err := s.deps.Mirror.MailboxState(ctx, s.mailboxID)
		if err != nil || st == nil {
			return 0
		}
		return st.Total
	}
	sink := push.NewIMAPIdleSink(s.deviceID, s.wr, existsFn)
	s.deps.Push.Subscribe(s.mailboxID, sink)
	s.idleActive = true
	s.idleSinkID = s.deviceID
	defer func() {
		s.deps.Push.Unsubscribe(s.mailboxID, sink.ID())
		s.idleActive = false
	}()

	// Block until DONE arrives or context cancels.
	doneCh := make(chan struct{})
	go func() {
		for {
			_ = s.conn.SetReadDeadline(time.Now().Add(29 * time.Minute))
			line, err := s.rd.ReadString('\n')
			if err != nil {
				close(doneCh)
				return
			}
			if strings.EqualFold(strings.TrimSpace(line), "DONE") {
				close(doneCh)
				return
			}
		}
	}()
	select {
	case <-ctx.Done():
		return nil
	case <-doneCh:
	}
	return s.taggedOK(tag, "IDLE terminated")
}

// --- helpers ---

func mergeFlags(op string, existing, given []string) []string {
	switch op {
	case "FLAGS":
		return given
	case "+FLAGS":
		out := append([]string{}, existing...)
		for _, f := range given {
			if !containsFlag(out, f) {
				out = append(out, f)
			}
		}
		return out
	case "-FLAGS":
		out := []string{}
		for _, f := range existing {
			if !containsFlag(given, f) {
				out = append(out, f)
			}
		}
		return out
	}
	return existing
}

func containsFlag(list []string, f string) bool {
	for _, l := range list {
		if strings.EqualFold(l, f) {
			return true
		}
	}
	return false
}
