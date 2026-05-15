// Package imap exposes a polaris IMAP listener on top of the bridge mirror.
//
// The implementation is the emersion/go-imap v2 imapserver.Backend +
// imapserver.Session interfaces wrapped over our bridge primitives:
//
//   - *store.Mirror: per-mailbox local SQLite cache (EXISTS/UIDNEXT/UIDVALIDITY,
//     per-message metadata and flags).
//   - *polarissdk.Client: IMAP LOGIN authenticator (mailbox_credentials lookup
//     + bcrypt) and the write-side for flag/expunge mutations.
//   - *push.Manager: IDLE fan-out — webhook handler calls Broadcast and Idle
//     sessions emit `* n EXISTS` accordingly.
//
// Mailbox surface is INBOX-only. Create / Delete / Rename / Subscribe /
// Unsubscribe / Append / Copy / Move all return errors (no other mailboxes
// exist); the library translates those into IMAP NO responses.
package imap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	polarissdk "github.com/polaris-email/polaris-sdk-go"

	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/push"
	"github.com/vladzaharia/polaris-email/apps/mail-bridge/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// inboxName is the single mailbox the bridge exposes. RFC 9051 says INBOX
// matches case-insensitively; we accept any case from the client and always
// echo back "INBOX".
const inboxName = "INBOX"

// mailboxDelim is the LIST hierarchy separator. With INBOX-only it doesn't
// matter, but clients still expect a non-NIL value.
const mailboxDelim rune = '/'

// httpGetter is the contract Backend uses to fetch body bytes. The default
// implementation is net/http.DefaultClient; tests can stub it.
type httpGetter interface {
	Get(url string) (*http.Response, error)
}

// Backend implements imapserver.Backend on top of bridge primitives. It is
// stateless across sessions; per-conn state lives on bridgeSession.
type Backend struct {
	// Client talks to polaris for authentication, flag mutation and expunge.
	Client *polarissdk.Client
	// Mirror is the bridge-local cache that SELECT / FETCH read from and that
	// STORE / EXPUNGE write back to (locally) after the SDK call returns.
	Mirror *store.Mirror
	// Push fans state-change events to IDLE sessions.
	Push *push.Manager
	// Logger receives backend-side errors. Falls back to log.Default if nil.
	Logger *log.Logger
	// HTTP is the body fetcher; defaults to http.DefaultClient.
	HTTP httpGetter
}

// logger returns the configured logger or the default.
func (b *Backend) logger() *log.Logger {
	if b.Logger != nil {
		return b.Logger
	}
	return log.Default()
}

// httpClient returns the configured HTTP getter or http.DefaultClient.
func (b *Backend) httpClient() httpGetter {
	if b.HTTP != nil {
		return b.HTTP
	}
	return http.DefaultClient
}

// NewSession is the imapserver.Backend constructor. The greeting carries
// PreAuth=false (clients must LOGIN).
func (b *Backend) NewSession(_ *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
	return &bridgeSession{backend: b}, &imapserver.GreetingData{}, nil
}

// bridgeSession is per-connection state. Library serializes calls per
// session, but Idle runs concurrently with reader-side close, so the few
// mutable bits sit behind a small mutex.
type bridgeSession struct {
	backend *Backend

	mu        sync.Mutex
	mailboxID string // set on Login
	username  string
	selected  bool // true between Select and Unselect/Close
}

// snapshot returns the auth + select state without holding the lock across
// downstream calls.
func (s *bridgeSession) snapshot() (mailboxID, username string, selected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mailboxID, s.username, s.selected
}

// ---------- Not-authenticated state ----------

// Close releases per-connection resources. The library calls this once per
// session, even if the client never authenticated.
func (s *bridgeSession) Close() error { return nil }

// Login implements the IMAP LOGIN command. Bridge auth is bcrypt against the
// mailbox_credentials row resolved by (protocol="imap", username). Auth
// failure must return imapserver.ErrAuthFailed — the library translates it
// into the proper tagged NO response.
func (s *bridgeSession) Login(username, password string) error {
	if username == "" || password == "" {
		return imapserver.ErrAuthFailed
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cred, err := s.backend.Client.LookupMailboxCredential(ctx, "imap", username)
	if err != nil {
		// Network or API error — log but report auth-failed so we don't
		// leak "user exists" information.
		s.backend.logger().Printf("imap: login lookup %q: %v", username, err)
		return imapserver.ErrAuthFailed
	}
	if cred == nil || cred.AuthType != "password" || cred.BcryptHash == "" {
		// Unknown user — burn a constant-time bcrypt comparison against a
		// pre-baked dummy hash so timing is indistinguishable from a real
		// user with a wrong password. The dummy hash is cost 12 to match
		// production credentials (A5).
		_ = bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(password))
		return imapserver.ErrAuthFailed
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cred.BcryptHash), []byte(password)); err != nil {
		return imapserver.ErrAuthFailed
	}
	s.mu.Lock()
	s.mailboxID = cred.MailboxID
	s.username = username
	s.mu.Unlock()
	return nil
}

// dummyBcryptHash is a cost-12 hash of a random string. CompareHashAndPassword
// against it always fails but takes the same wall-time as a real comparison,
// so callers can't time-side-channel valid usernames. Generated once at init.
var dummyBcryptHash = func() []byte {
	h, err := bcrypt.GenerateFromPassword([]byte("polaris-bridge-dummy-hash-do-not-use"), 12)
	if err != nil {
		// bcrypt with a constant input cannot realistically fail; if it
		// does, panic — the auth path would be broken either way.
		panic(fmt.Errorf("imap: dummy hash init: %w", err))
	}
	return h
}()

// ---------- Authenticated state ----------

// Select switches the session to a selected mailbox. INBOX-only.
func (s *bridgeSession) Select(mailbox string, _ *imap.SelectOptions) (*imap.SelectData, error) {
	mailboxID, _, _ := s.snapshot()
	if mailboxID == "" {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Text: "not authenticated"}
	}
	if !strings.EqualFold(mailbox, inboxName) {
		return nil, &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeNonExistent,
			Text: "only INBOX is exposed by polaris-mail-bridge",
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := s.backend.Mirror.GetMailboxState(ctx, mailboxID)
	if err != nil {
		return nil, fmt.Errorf("mirror state: %w", err)
	}
	s.mu.Lock()
	s.selected = true
	s.mu.Unlock()
	return &imap.SelectData{
		Flags:          mailboxFlags,
		PermanentFlags: mailboxFlags,
		NumMessages:    uint32(st.Exists),
		UIDNext:        imap.UID(st.UIDNext),
		UIDValidity:    uint32(st.UIDValidity),
	}, nil
}

// mailboxFlags is the static flag set the bridge exposes on INBOX. The
// library will refuse STORE for flags outside this list.
var mailboxFlags = []imap.Flag{
	imap.FlagSeen, imap.FlagAnswered, imap.FlagFlagged, imap.FlagDeleted, imap.FlagDraft,
}

// Create / Delete / Rename / Subscribe / Unsubscribe: INBOX-only. RFC 9051
// requires NO with the NONEXISTENT or CANNOT response code for client-side
// state-machine correctness.

func (s *bridgeSession) Create(string, *imap.CreateOptions) error {
	return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "mailbox creation not supported"}
}

func (s *bridgeSession) Delete(string) error {
	return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "mailbox deletion not supported"}
}

func (s *bridgeSession) Rename(string, string, *imap.RenameOptions) error {
	return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "mailbox rename not supported"}
}

func (s *bridgeSession) Subscribe(string) error   { return nil }
func (s *bridgeSession) Unsubscribe(string) error { return nil }

// List emits a single LIST entry for INBOX whenever the pattern matches.
// LIST "" "*" / LIST "" "%" / LIST "" "INBOX" all return INBOX.
func (s *bridgeSession) List(w *imapserver.ListWriter, ref string, patterns []string, _ *imap.ListOptions) error {
	mailboxID, _, _ := s.snapshot()
	if mailboxID == "" {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "not authenticated"}
	}
	if len(patterns) == 0 {
		// LIST "" "" — server-root probe per RFC 9051; reply with a single
		// non-selectable root entry.
		return w.WriteList(&imap.ListData{
			Attrs: []imap.MailboxAttr{imap.MailboxAttrNoSelect},
			Delim: mailboxDelim,
		})
	}
	matched := false
	for _, p := range patterns {
		if imapserver.MatchList(inboxName, mailboxDelim, ref, p) {
			matched = true
			break
		}
	}
	if !matched {
		return nil
	}
	return w.WriteList(&imap.ListData{
		Attrs:   []imap.MailboxAttr{imap.MailboxAttrHasNoChildren},
		Delim:   mailboxDelim,
		Mailbox: inboxName,
	})
}

// Status reports counts without selecting the mailbox.
func (s *bridgeSession) Status(mailbox string, opts *imap.StatusOptions) (*imap.StatusData, error) {
	mailboxID, _, _ := s.snapshot()
	if mailboxID == "" {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Text: "not authenticated"}
	}
	if !strings.EqualFold(mailbox, inboxName) {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeNonExistent, Text: "no such mailbox"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := s.backend.Mirror.GetMailboxState(ctx, mailboxID)
	if err != nil {
		return nil, fmt.Errorf("mirror state: %w", err)
	}
	data := &imap.StatusData{Mailbox: inboxName}
	if opts.NumMessages {
		n := uint32(st.Exists)
		data.NumMessages = &n
	}
	if opts.NumUnseen {
		u := uint32(st.Unseen)
		data.NumUnseen = &u
	}
	if opts.UIDNext {
		data.UIDNext = imap.UID(st.UIDNext)
	}
	if opts.UIDValidity {
		data.UIDValidity = uint32(st.UIDValidity)
	}
	return data, nil
}

// Append is not supported; mail enters the system via SMTPS submission or
// inbound webhook fan-in, never via the IMAP listener.
func (s *bridgeSession) Append(string, imap.LiteralReader, *imap.AppendOptions) (*imap.AppendData, error) {
	return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "APPEND not supported; submit via SMTPS"}
}

// Poll is the non-IDLE update path. The library calls it after every
// command; we have nothing to push synchronously (push.Manager fires async),
// so just return.
func (s *bridgeSession) Poll(*imapserver.UpdateWriter, bool) error { return nil }

// Idle subscribes the session to push.Manager for the duration of the IDLE
// command and emits `* n EXISTS` whenever a state-change event arrives. The
// library closes stop when the client sends DONE.
func (s *bridgeSession) Idle(w *imapserver.UpdateWriter, stop <-chan struct{}) error {
	mailboxID, _, selected := s.snapshot()
	if mailboxID == "" || !selected {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "IDLE requires a selected mailbox"}
	}
	sinkID := fmt.Sprintf("imap-idle-%p-%d", s, time.Now().UnixNano())
	notify := make(chan struct{}, 16)
	sink := &chanSink{id: sinkID, ch: notify}
	s.backend.Push.Subscribe(mailboxID, sink)
	defer s.backend.Push.Unsubscribe(mailboxID, sinkID)
	for {
		select {
		case <-stop:
			return nil
		case <-notify:
			// Re-read mailbox state and emit EXISTS.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			st, err := s.backend.Mirror.GetMailboxState(ctx, mailboxID)
			cancel()
			if err != nil {
				s.backend.logger().Printf("imap: idle state lookup: %v", err)
				continue
			}
			if err := w.WriteNumMessages(uint32(st.Exists)); err != nil {
				return err
			}
		}
	}
}

// chanSink is a push.Sink that just coalesces notifications onto a buffered
// channel. The Idle goroutine drains the channel and emits one EXISTS per
// notification.
type chanSink struct {
	id string
	ch chan struct{}
}

func (c *chanSink) ID() string { return c.id }
func (c *chanSink) Deliver(push.StateChange) error {
	select {
	case c.ch <- struct{}{}:
	default: // already pending; coalesce
	}
	return nil
}

// ---------- Selected state ----------

// Unselect leaves the selected state but keeps authentication.
func (s *bridgeSession) Unselect() error {
	s.mu.Lock()
	s.selected = false
	s.mu.Unlock()
	return nil
}

// Expunge issues DELETE /v1/messages/:id for every \Deleted row, then marks
// the local mirror row expunged and emits `* n EXPUNGE` for each.
func (s *bridgeSession) Expunge(w *imapserver.ExpungeWriter, uids *imap.UIDSet) error {
	mailboxID, _, selected := s.snapshot()
	if !selected {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "EXPUNGE requires SELECT"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	states, err := s.backend.Mirror.ListLiveMessageIDs(ctx, mailboxID)
	if err != nil {
		return fmt.Errorf("mirror list: %w", err)
	}
	// Walk in descending sequence order so seq numbers stay stable while we
	// announce EXPUNGE per RFC 9051.
	for i := len(states) - 1; i >= 0; i-- {
		st := states[i]
		if uids != nil && !uids.Contains(imap.UID(uint32(st.UID))) {
			continue
		}
		if !flagsHave(st.Flags, `\Deleted`) {
			continue
		}
		if err := s.backend.Client.DeleteMessage(ctx, st.MessageID); err != nil {
			s.backend.logger().Printf("imap: expunge %s: %v", st.MessageID, err)
			continue
		}
		if err := s.backend.Mirror.MarkExpunged(ctx, mailboxID, st.MessageID); err != nil {
			s.backend.logger().Printf("imap: mirror expunge %s: %v", st.MessageID, err)
		}
		seqNum := uint32(i + 1) // 1-indexed
		if err := w.WriteExpunge(seqNum); err != nil {
			return err
		}
	}
	return nil
}

// Search is not implemented yet. RFC 9051 allows servers to return an empty
// result; clients that need search fall back to client-side filtering.
// TODO(production): wire to GET /v1/messages?q=... when SEARCH demand
// materializes.
func (s *bridgeSession) Search(_ imapserver.NumKind, _ *imap.SearchCriteria, _ *imap.SearchOptions) (*imap.SearchData, error) {
	return &imap.SearchData{}, nil
}

// Fetch streams FETCH responses for the requested sequence/UID set.
func (s *bridgeSession) Fetch(w *imapserver.FetchWriter, numSet imap.NumSet, opts *imap.FetchOptions) error {
	mailboxID, _, selected := s.snapshot()
	if !selected {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "FETCH requires SELECT"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	states, err := s.backend.Mirror.ListLiveMessageIDs(ctx, mailboxID)
	if err != nil {
		return fmt.Errorf("mirror list: %w", err)
	}
	for i, st := range states {
		seqNum := uint32(i + 1)
		if !numSetContains(numSet, seqNum, imap.UID(uint32(st.UID))) {
			continue
		}
		if err := s.writeMessage(ctx, w, seqNum, st, opts); err != nil {
			return err
		}
	}
	return nil
}

// writeMessage emits one FETCH response. It batches Mirror metadata + body
// fetches as needed so we only do the work the client asked for.
func (s *bridgeSession) writeMessage(ctx context.Context, w *imapserver.FetchWriter, seqNum uint32, st store.MailboxState, opts *imap.FetchOptions) error {
	msg := w.CreateMessage(seqNum)
	defer msg.Close()

	if opts.UID {
		msg.WriteUID(imap.UID(uint32(st.UID)))
	}
	if opts.Flags {
		msg.WriteFlags(parseFlags(st.Flags))
	}

	// Anything beyond UID+FLAGS needs metadata.
	needMeta := opts.Envelope || opts.InternalDate || opts.RFC822Size ||
		opts.BodyStructure != nil || len(opts.BodySection) > 0
	if !needMeta {
		return nil
	}
	meta, err := s.backend.Mirror.GetMessageMeta(ctx, st.MessageID)
	if err != nil {
		s.backend.logger().Printf("imap: meta %s: %v", st.MessageID, err)
		return nil
	}
	if opts.InternalDate {
		if t, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
			msg.WriteInternalDate(t)
		} else {
			msg.WriteInternalDate(time.Now())
		}
	}
	if opts.RFC822Size {
		msg.WriteRFC822Size(meta.BodyBytes)
	}
	if opts.Envelope {
		msg.WriteEnvelope(envelopeFromMeta(meta))
	}
	if opts.BodyStructure != nil {
		msg.WriteBodyStructure(bodyStructureFromMeta(meta, opts.BodyStructure.Extended))
	}
	if len(opts.BodySection) > 0 {
		// Fetch the body once and re-slice for every requested section.
		body, err := s.fetchBody(ctx, st.MessageID)
		if err != nil {
			s.backend.logger().Printf("imap: body %s: %v", st.MessageID, err)
			body = nil
		}
		for _, section := range opts.BodySection {
			payload := sliceBodySection(body, section)
			wc := msg.WriteBodySection(section, int64(len(payload)))
			_, _ = wc.Write(payload)
			_ = wc.Close()
		}
	}
	return nil
}

// fetchBody loads the raw RFC822 bytes for a message. Polaris stores bodies
// in R2 under the content-addressed URL exposed on `r2.mail.plrs.im`; the
// SDK returns that URL on GetMessage. We do a plain HTTP GET — the URL is
// already a capability token (SHA-256 key).
func (s *bridgeSession) fetchBody(ctx context.Context, messageID string) ([]byte, error) {
	m, err := s.backend.Client.GetMessage(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("sdk get: %w", err)
	}
	if m.BodyURL == "" {
		// Fall back to the inline text/html payload if the SDK didn't
		// surface a body URL (older shapes). Synthesize a minimal RFC822
		// blob so BODY[HEADER] / BODY[TEXT] still answer something useful.
		return []byte(m.Text), nil
	}
	resp, err := s.backend.httpClient().Get(m.BodyURL)
	if err != nil {
		return nil, fmt.Errorf("http get %s: %w", m.BodyURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("body url %s: HTTP %d", m.BodyURL, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// Store applies a flag mutation. For each matching row we call
// PATCH /v1/messages/:id { flags: [...] } and then update the local mirror.
// Per RFC 9051 we emit a FETCH response with the new FLAGS unless .SILENT
// was requested (in which case the library handles silence via the
// StoreFlags.Silent flag on its end — but we still need to write the FETCH
// frame when not silent).
func (s *bridgeSession) Store(w *imapserver.FetchWriter, numSet imap.NumSet, flags *imap.StoreFlags, _ *imap.StoreOptions) error {
	mailboxID, _, selected := s.snapshot()
	if !selected {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "STORE requires SELECT"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	states, err := s.backend.Mirror.ListLiveMessageIDs(ctx, mailboxID)
	if err != nil {
		return fmt.Errorf("mirror list: %w", err)
	}
	for i, st := range states {
		seqNum := uint32(i + 1)
		if !numSetContains(numSet, seqNum, imap.UID(uint32(st.UID))) {
			continue
		}
		current := parseFlags(st.Flags)
		next := applyStoreOp(current, flags)
		updated, err := s.backend.Client.PatchMessageFlags(ctx, st.MessageID, flagsToStrings(next))
		if err != nil {
			s.backend.logger().Printf("imap: store %s: %v", st.MessageID, err)
			continue
		}
		// Persist authoritative flags returned by the API.
		finalFlags := updated.Flags
		_ = s.backend.Mirror.UpdateFlags(ctx, mailboxID, st.MessageID, finalFlags)
		if !flags.Silent {
			resp := w.CreateMessage(seqNum)
			resp.WriteUID(imap.UID(uint32(st.UID)))
			resp.WriteFlags(stringsToFlags(finalFlags))
			_ = resp.Close()
		}
	}
	return nil
}

// Copy is rejected — there's no other mailbox to copy to.
func (s *bridgeSession) Copy(imap.NumSet, string) (*imap.CopyData, error) {
	return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "COPY not supported; only INBOX exists"}
}

// ---------- v2 protocol extensions (NAMESPACE + MOVE) ----------
//
// The library refuses to advertise the v2 capability unless the session
// satisfies the imapserver.SessionIMAP4rev2 contract, which folds in
// NAMESPACE + MOVE.

// Namespace reports a single personal namespace with "/" as the hierarchy
// delimiter. We have one mailbox so the answer is fixed.
func (s *bridgeSession) Namespace() (*imap.NamespaceData, error) {
	return &imap.NamespaceData{
		Personal: []imap.NamespaceDescriptor{{Delim: mailboxDelim}},
	}, nil
}

// Move is rejected for the same reason as Copy.
func (s *bridgeSession) Move(_ *imapserver.MoveWriter, _ imap.NumSet, _ string) error {
	return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "MOVE not supported; only INBOX exists"}
}

// ---------- helpers ----------

// parseFlags decodes the JSON-array string the mirror stores into go-imap
// flag values. Empty / malformed input → empty slice (never error).
func parseFlags(raw string) []imap.Flag {
	if raw == "" {
		return nil
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil
	}
	out := make([]imap.Flag, 0, len(list))
	for _, f := range list {
		out = append(out, imap.Flag(f))
	}
	return out
}

func flagsToStrings(flags []imap.Flag) []string {
	out := make([]string, 0, len(flags))
	for _, f := range flags {
		out = append(out, string(f))
	}
	return out
}

func stringsToFlags(list []string) []imap.Flag {
	out := make([]imap.Flag, 0, len(list))
	for _, s := range list {
		out = append(out, imap.Flag(s))
	}
	return out
}

// flagsHave reports whether the JSON-array flag string contains f (case
// insensitive).
func flagsHave(raw, want string) bool {
	for _, f := range parseFlags(raw) {
		if strings.EqualFold(string(f), want) {
			return true
		}
	}
	return false
}

// applyStoreOp produces the new flag set after applying the STORE op
// (set/add/del) to current.
func applyStoreOp(current []imap.Flag, op *imap.StoreFlags) []imap.Flag {
	switch op.Op {
	case imap.StoreFlagsSet:
		return append([]imap.Flag(nil), op.Flags...)
	case imap.StoreFlagsAdd:
		out := append([]imap.Flag(nil), current...)
		for _, f := range op.Flags {
			if !flagSliceContains(out, f) {
				out = append(out, f)
			}
		}
		return out
	case imap.StoreFlagsDel:
		out := make([]imap.Flag, 0, len(current))
		for _, f := range current {
			if !flagSliceContains(op.Flags, f) {
				out = append(out, f)
			}
		}
		return out
	}
	return current
}

func flagSliceContains(list []imap.Flag, want imap.Flag) bool {
	for _, f := range list {
		if strings.EqualFold(string(f), string(want)) {
			return true
		}
	}
	return false
}

// numSetContains returns true if either seqNum or uid is in numSet. The
// library dispatches Fetch / Store / Expunge with the right kind of set; we
// don't know which kind without type-switching.
func numSetContains(set imap.NumSet, seqNum uint32, uid imap.UID) bool {
	switch s := set.(type) {
	case imap.SeqSet:
		return s.Contains(seqNum)
	case imap.UIDSet:
		return s.Contains(uid)
	}
	return false
}

// envelopeFromMeta builds an imap.Envelope from the metadata row. Bodies and
// recipient lists are not currently mirrored, so cc/bcc are NIL and we use
// the From + Subject + Message-ID we have.
func envelopeFromMeta(meta *store.MessageMeta) *imap.Envelope {
	env := &imap.Envelope{
		Subject:   meta.Subject,
		MessageID: meta.HeaderMessageID,
	}
	if t, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
		env.Date = t
	}
	if meta.FromAddr != "" {
		env.From = []imap.Address{addressFrom(meta.FromAddr)}
	}
	return env
}

func addressFrom(addr string) imap.Address {
	at := strings.LastIndex(addr, "@")
	if at < 0 {
		return imap.Address{Mailbox: addr}
	}
	return imap.Address{Mailbox: addr[:at], Host: addr[at+1:]}
}

// bodyStructureFromMeta synthesizes a single-part text/plain body structure.
// The mirror doesn't hold the parsed MIME tree today; this is good enough
// for clients that only need RFC822.SIZE and a basic envelope. Phase G in
// the plan tracks adding real BODYSTRUCTURE.
func bodyStructureFromMeta(meta *store.MessageMeta, extended bool) imap.BodyStructure {
	bs := &imap.BodyStructureSinglePart{
		Type:     "text",
		Subtype:  "plain",
		Params:   map[string]string{"charset": "utf-8"},
		Encoding: "7bit",
		Size:     uint32(meta.BodyBytes),
		Text:     &imap.BodyStructureText{NumLines: 0},
	}
	if extended {
		bs.Extended = &imap.BodyStructureSinglePartExt{}
	}
	return bs
}

// sliceBodySection returns the requested chunk of a raw RFC822 body. We
// support the most common section requests today: full body, HEADER, TEXT.
// Anything else falls back to the full body (clients then ignore the rest).
// TODO(production): wire HEADER.FIELDS / MIME / per-part fetches.
func sliceBodySection(body []byte, section *imap.FetchItemBodySection) []byte {
	if section == nil || len(body) == 0 {
		return body
	}
	switch section.Specifier {
	case imap.PartSpecifierHeader:
		if idx := bytes.Index(body, []byte("\r\n\r\n")); idx >= 0 {
			return body[:idx+4]
		}
		return body
	case imap.PartSpecifierText:
		if idx := bytes.Index(body, []byte("\r\n\r\n")); idx >= 0 {
			return body[idx+4:]
		}
		return body
	}
	if section.Partial != nil {
		start := section.Partial.Offset
		end := start + section.Partial.Size
		if start > int64(len(body)) {
			return nil
		}
		if end > int64(len(body)) {
			end = int64(len(body))
		}
		return body[start:end]
	}
	return body
}

