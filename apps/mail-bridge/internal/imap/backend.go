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
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	polarissdk "github.com/polaris-mail/polaris-sdk-go"

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

// defaultMaxBodyBytes caps an IMAP BODY[] fetch when Backend.MaxBodyBytes
// is zero. 64 MiB matches the upstream R2 multipart upload ceiling.
const defaultMaxBodyBytes = int64(64 << 20)

// idleKeepaliveInterval is the cadence at which an IDLE session emits an
// idempotent `* n EXISTS` solely to keep the TCP connection from being
// dropped by middleboxes (typical timeout is 5 minutes; 20 minutes is well
// inside RFC 9051's 29-minute IDLE ceiling but still avoids most NAT
// timeouts when the client extends the IDLE).
const idleKeepaliveInterval = 20 * time.Minute

// httpDoer is the contract Backend uses to fetch body bytes. Pre-2e this
// was httpGetter (Get(url)), which precluded passing a context for
// cancellation. The new shape mirrors http.Client and lets the IMAP
// session's context tear down a stalled R2 fetch when the client closes
// the connection.
type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
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
	// HTTP is the body fetcher; defaults to a 30s-timeout client. Tests can
	// stub it.
	HTTP httpDoer
	// MaxBodyBytes caps the byte count read from R2 in fetchBody. Zero ⇒
	// defaultMaxBodyBytes. The cap defends the bridge against an oversized
	// attachment turning a single FETCH into a multi-hundred-MB allocation.
	MaxBodyBytes int64
	// R2PublicHost is the expected host suffix for BodyURL values returned
	// by the SDK. The SDK is generally trusted but BodyURL is technically
	// server-controlled data we then fetch unauthenticated — pinning the
	// host suffix prevents a misconfigured server from steering the bridge
	// into fetching arbitrary endpoints. Empty value disables the check.
	R2PublicHost string
}

// defaultHTTPClient is a 30-second-timeout client used when Backend.HTTP is
// unset. Defining it once at package scope lets the same client be reused
// across sessions and avoids a per-fetch allocation.
var defaultHTTPClient = &http.Client{Timeout: 30 * time.Second}

// logger returns the configured logger or the default.
func (b *Backend) logger() *log.Logger {
	if b.Logger != nil {
		return b.Logger
	}
	return log.Default()
}

// httpClient returns the configured HTTP doer or the default.
func (b *Backend) httpClient() httpDoer {
	if b.HTTP != nil {
		return b.HTTP
	}
	return defaultHTTPClient
}

// maxBodyBytes returns the effective body-fetch cap.
func (b *Backend) maxBodyBytes() int64 {
	if b.MaxBodyBytes > 0 {
		return b.MaxBodyBytes
	}
	return defaultMaxBodyBytes
}

// validateBodyURL checks that the SDK-supplied body URL points at the
// expected R2 public host (when configured). Refusing unexpected hosts
// keeps a misconfigured server from steering the bridge into fetching
// arbitrary endpoints.
func (b *Backend) validateBodyURL(raw string) error {
	if b.R2PublicHost == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("body url parse: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("body url scheme %q not https", u.Scheme)
	}
	host := u.Hostname()
	want := b.R2PublicHost
	if host != want && !strings.HasSuffix(host, "."+want) {
		return fmt.Errorf("body url host %q not under %q", host, want)
	}
	return nil
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
		// production credentials.
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

// Subscribe / Unsubscribe are no-ops because INBOX is the only mailbox
// the bridge exposes (and is implicitly always-subscribed per RFC 9051
// §6.3.6). We accept any folder name to match what real clients expect:
// some tools issue SUBSCRIBE for synthetic folders during setup, then
// drop them. Returning NO would block onboarding without affording any
// real correctness benefit. The List handler treats INBOX as subscribed
// when the client sets ListOptions.SelectSubscribed (Phase 4c.3).
func (s *bridgeSession) Subscribe(string) error   { return nil }
func (s *bridgeSession) Unsubscribe(string) error { return nil }

// List emits a single LIST entry for INBOX whenever the pattern matches.
// LIST "" "*" / LIST "" "%" / LIST "" "INBOX" all return INBOX.
//
// When the client sets ListOptions.SelectSubscribed (LSUB / LIST
// (SUBSCRIBED) per RFC 9051 §6.3.10), we still emit INBOX — Phase 4c.3
// treats INBOX as implicitly always-subscribed (RFC 9051 §6.3.6). The
// MailboxAttrSubscribed attribute is added so clients that switch on
// ReturnSubscribed get the right metadata.
func (s *bridgeSession) List(w *imapserver.ListWriter, ref string, patterns []string, opts *imap.ListOptions) error {
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
	attrs := []imap.MailboxAttr{imap.MailboxAttrHasNoChildren}
	// SelectSubscribed (LSUB / LIST (SUBSCRIBED)) — INBOX is always
	// considered subscribed per RFC 9051 §6.3.6, so we always pass the
	// filter. ReturnSubscribed asks the server to advertise the
	// \Subscribed attribute on the result; safe to add unconditionally.
	if opts != nil && (opts.ReturnSubscribed || opts.SelectSubscribed) {
		attrs = append(attrs, imap.MailboxAttrSubscribed)
	}
	return w.WriteList(&imap.ListData{
		Attrs:   attrs,
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
//
// We also tick every idleKeepaliveInterval and emit an idempotent EXISTS so
// firewalls / NAT middleboxes don't drop the otherwise-silent connection.
// Re-emitting the current count is harmless per RFC 9051 §7.4.1 (clients
// MUST tolerate untagged responses outside of any specific command).
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
	keepalive := time.NewTicker(idleKeepaliveInterval)
	defer keepalive.Stop()
	for {
		select {
		case <-stop:
			return nil
		case <-keepalive.C:
			// Idempotent re-broadcast of the current EXISTS count. Doubles
			// as a TCP keepalive for middleboxes that drop idle connections.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			st, err := s.backend.Mirror.GetMailboxState(ctx, mailboxID)
			cancel()
			if err != nil {
				s.backend.logger().Printf("imap: idle keepalive lookup: %v", err)
				continue
			}
			if err := w.WriteNumMessages(uint32(st.Exists)); err != nil {
				return err
			}
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
//
// EXPUNGE sequence numbers are tricky: per RFC 9051 §7.4.1, after the
// server emits `* N EXPUNGE` the message at sequence N is gone and every
// later sequence number is decremented by one. We must emit numbers
// computed against the CURRENT (post-prior-EXPUNGE) sequence map, NOT the
// original index. The pre-2e implementation used `i + 1` against the
// descending walk index, which only worked when at most one message was
// being expunged — multi-message EXPUNGE pointed clients at the wrong rows.
//
// Strategy: walk in ascending order, track how many messages we've already
// announced as expunged, and emit the original 1-indexed seq minus that
// count (which is the message's CURRENT seq number after prior emits).
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
	expungedSoFar := uint32(0)
	for i, st := range states {
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
		// Mirror update MUST succeed before we tell the client the message
		// is gone — otherwise the client thinks UID X is expunged but our
		// next FETCH still surfaces it (mirror inconsistency caught in
		// Phase 2e bug #7).
		if err := s.backend.Mirror.MarkExpunged(ctx, mailboxID, st.MessageID); err != nil {
			s.backend.logger().Printf("imap: mirror expunge %s: %v (aborting EXPUNGE batch)", st.MessageID, err)
			return fmt.Errorf("mirror expunge %s: %w", st.MessageID, err)
		}
		// Original 1-indexed seq is i+1; subtract count of prior EXPUNGEs
		// to get the seq number from the client's current view.
		seqNum := uint32(i+1) - expungedSoFar
		expungedSoFar++
		if err := w.WriteExpunge(seqNum); err != nil {
			return err
		}
	}
	return nil
}

// Search implements a minimal IMAP SEARCH subset (Phase 4c.1) that runs
// entirely against the local mirror. Supported criteria:
//
//   - ALL                 → every live UID
//   - UNSEEN              → live UIDs whose flags don't contain "\Seen"
//   - SEEN                → live UIDs whose flags do contain "\Seen"
//   - SINCE <date>        → live UIDs whose internal_date (mirror created_at)
//                           is on or after the given date (date only, time
//                           ignored per RFC 3501 §6.4.4)
//   - BEFORE <date>       → live UIDs strictly before
//   - UID <set>           → filter the input set to live UIDs
//   - SEQ <set>           → filter the input set to live sequence numbers
//
// All criteria are AND-combined (intersection). Anything more exotic
// (BODY/TEXT search, OR, NOT) is silently treated as "match nothing" so
// a misbehaving client doesn't get a wildly-wrong result set; clients can
// always fall back to client-side filtering.
//
// Returns the matching set as either a SeqSet or UIDSet according to the
// command's NumKind (FETCH/STORE/EXPUNGE will accept either).
func (s *bridgeSession) Search(kind imapserver.NumKind, criteria *imap.SearchCriteria, _ *imap.SearchOptions) (*imap.SearchData, error) {
	mailboxID, _, selected := s.snapshot()
	if !selected {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Text: "SEARCH requires SELECT"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	states, err := s.backend.Mirror.ListLiveMessageIDs(ctx, mailboxID)
	if err != nil {
		return nil, fmt.Errorf("mirror list: %w", err)
	}

	// We need internal_date for SINCE/BEFORE; pull metadata lazily on
	// first need to avoid the per-row hit when only flag/UID criteria
	// are in play.
	needDate := criteria != nil && (!criteria.Since.IsZero() || !criteria.Before.IsZero())
	dateCache := map[string]time.Time{}
	loadDate := func(messageID string) time.Time {
		if t, ok := dateCache[messageID]; ok {
			return t
		}
		meta, err := s.backend.Mirror.GetMessageMeta(ctx, mailboxID, messageID)
		if err != nil {
			dateCache[messageID] = time.Time{}
			return time.Time{}
		}
		t, _ := time.Parse(time.RFC3339, meta.CreatedAt)
		dateCache[messageID] = t
		return t
	}

	matchedSeq := imap.SeqSet{}
	matchedUID := imap.UIDSet{}
	for i, st := range states {
		seqNum := uint32(i + 1)
		uid := imap.UID(uint32(st.UID))
		if !matchesSearchCriteria(criteria, seqNum, uid, st, needDate, loadDate) {
			continue
		}
		matchedSeq.AddNum(seqNum)
		matchedUID.AddNum(uid)
	}

	if kind == imapserver.NumKindUID {
		return &imap.SearchData{All: matchedUID, Count: uint32(len(states))}, nil
	}
	return &imap.SearchData{All: matchedSeq, Count: uint32(len(states))}, nil
}

// matchesSearchCriteria returns true if the row satisfies every populated
// field on criteria. Treats nil criteria as "match all" (the imapserver
// library defaults to no-criteria-set when only RETURN options are sent).
func matchesSearchCriteria(c *imap.SearchCriteria, seqNum uint32, uid imap.UID, st store.MailboxState, needDate bool, loadDate func(string) time.Time) bool {
	if c == nil {
		return true
	}
	// SeqNum / UID restriction sets — every set is a constraint that
	// must contain the row.
	for _, set := range c.SeqNum {
		if !set.Contains(seqNum) {
			return false
		}
	}
	for _, set := range c.UID {
		if !set.Contains(uid) {
			return false
		}
	}
	// Flag membership.
	for _, want := range c.Flag {
		if !flagsHave(st.Flags, string(want)) {
			return false
		}
	}
	for _, banned := range c.NotFlag {
		if flagsHave(st.Flags, string(banned)) {
			return false
		}
	}
	// Date range. RFC 3501 SEARCH dates ignore time-of-day; we do the
	// same by truncating to the start of the day in UTC.
	if needDate {
		got := loadDate(st.MessageID).UTC()
		if !c.Since.IsZero() {
			since := truncDay(c.Since)
			if got.Before(since) {
				return false
			}
		}
		if !c.Before.IsZero() {
			before := truncDay(c.Before)
			if !got.Before(before) {
				return false
			}
		}
	}
	// We do not implement BODY/TEXT/HEADER/SentSince/SentBefore/Larger/
	// Smaller/Or/Not yet. If any of those are populated treat as
	// no-match so we don't surface a false-positive set; clients can
	// fall back to client-side filtering on the FETCH result.
	if len(c.Body) > 0 || len(c.Text) > 0 || len(c.Header) > 0 ||
		!c.SentSince.IsZero() || !c.SentBefore.IsZero() ||
		c.Larger > 0 || c.Smaller > 0 ||
		len(c.Not) > 0 || len(c.Or) > 0 || c.ModSeq != nil {
		return false
	}
	return true
}

// truncDay returns t at 00:00:00 UTC on the same calendar day. Used so
// SINCE/BEFORE comparisons match RFC 3501 date semantics regardless of
// the time component the client may have included.
func truncDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
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
		if err := s.writeMessage(ctx, w, mailboxID, seqNum, st, opts); err != nil {
			return err
		}
	}
	return nil
}

// writeMessage emits one FETCH response. It batches Mirror metadata + body
// fetches as needed so we only do the work the client asked for. mailboxID
// scopes every metadata lookup so a stale `MailboxState.MessageID` cannot
// surface metadata for a different mailbox.
func (s *bridgeSession) writeMessage(ctx context.Context, w *imapserver.FetchWriter, mailboxID string, seqNum uint32, st store.MailboxState, opts *imap.FetchOptions) error {
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
	meta, err := s.backend.Mirror.GetMessageMeta(ctx, mailboxID, st.MessageID)
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
		body, err := s.fetchBody(ctx, st.MessageID, meta)
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
		// Phase 4c.4 note on BODY.PEEK[] vs BODY[]:
		//
		// Per RFC 9051 §6.4.5 a non-PEEK BODY[] fetch MUST implicitly set
		// the \Seen flag on the affected message; BODY.PEEK[] suppresses
		// that side effect. The bridge does NOT currently auto-set \Seen
		// — clients have always had to issue an explicit STORE +FLAGS.
		// Because the side effect doesn't exist, PEEK is moot: every
		// BODY[] behaves identically to BODY.PEEK[]. If we wire
		// auto-\Seen later, this is the call site that needs the
		// `if !section.Peek { Mirror.UpdateFlags(...+\Seen) }` branch.
	}
	return nil
}

// fetchBody loads the raw RFC822 bytes for a message. Polaris stores bodies
// in R2 under the content-addressed URL exposed on `r2.mail.plrs.im`; the
// SDK returns that URL on GetMessage. We do a plain HTTP GET — the URL is
// already a capability token (SHA-256 key).
//
// Two safety measures the pre-2e implementation lacked:
//
//  1. The HTTP request carries the session's ctx (cancelled when the IMAP
//     conn closes), so a stalled R2 fetch cannot wedge an idle session.
//  2. The response body is wrapped in an io.LimitReader at MaxBodyBytes so
//     a 10 GB attachment can't OOM the bridge.
//
// When the SDK returns no body URL we synthesize a minimal RFC822 wrapper
// from the metadata + inline text so BODY[HEADER] / BODY[TEXT] still answer
// something parseable. Returning a bare body (the pre-2e behavior) made
// HEADER fetches return blank because sliceBodySection couldn't find the
// header/body separator.
func (s *bridgeSession) fetchBody(ctx context.Context, messageID string, meta *store.MessageMeta) ([]byte, error) {
	m, err := s.backend.Client.GetMessage(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("sdk get: %w", err)
	}
	if m.BodyURL == "" {
		// Synthesize a minimal RFC822 envelope so downstream slicing can
		// still find the header/body separator. This is the "graceful
		// degradation" branch for messages that haven't been promoted to
		// R2 yet (very small messages or rows predating content-addressed
		// storage).
		return synthesizeRFC822(m, meta), nil
	}
	if err := s.backend.validateBodyURL(m.BodyURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.BodyURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	resp, err := s.backend.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("http get %s: %w", m.BodyURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("body url %s: HTTP %d", m.BodyURL, resp.StatusCode)
	}
	cap := s.backend.maxBodyBytes()
	limited := io.LimitReader(resp.Body, cap+1)
	buf, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if int64(len(buf)) > cap {
		s.backend.logger().Printf("imap: body %s exceeds %d-byte cap; truncating", messageID, cap)
		buf = buf[:cap]
	}
	return buf, nil
}

// synthesizeRFC822 builds a minimal RFC822 representation from metadata plus
// the inline text/html payload. Used when the message has no BodyURL — the
// caller's BODY[HEADER]/BODY[TEXT] slicing relies on the CRLF-CRLF
// separator, so the returned bytes ALWAYS include header/body framing.
func synthesizeRFC822(m *polarissdk.Message, meta *store.MessageMeta) []byte {
	subject := m.Subject
	if subject == "" && meta != nil {
		subject = meta.Subject
	}
	from := m.From
	if from == "" {
		from = m.FromAddr
		if from == "" && meta != nil {
			from = meta.FromAddr
		}
	}
	date := m.CreatedAt
	if date == "" && meta != nil {
		date = meta.CreatedAt
	}
	headerMessageID := m.HeaderMessageID
	if headerMessageID == "" && meta != nil {
		headerMessageID = meta.HeaderMessageID
	}
	body := m.Text
	if body == "" {
		body = m.HTML
	}

	var b bytes.Buffer
	if from != "" {
		fmt.Fprintf(&b, "From: %s\r\n", sanitizeHeader(from))
	}
	if subject != "" {
		fmt.Fprintf(&b, "Subject: %s\r\n", sanitizeHeader(subject))
	}
	if date != "" {
		fmt.Fprintf(&b, "Date: %s\r\n", sanitizeHeader(date))
	}
	if headerMessageID != "" {
		fmt.Fprintf(&b, "Message-ID: %s\r\n", sanitizeHeader(headerMessageID))
	}
	if m.HTML != "" && m.Text == "" {
		b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	} else {
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	}
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return b.Bytes()
}

// sanitizeHeader strips CR/LF so a rogue `\r\n` in metadata can't smuggle
// header injection into the synthesized RFC822 blob.
func sanitizeHeader(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
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
		// Persist authoritative flags returned by the API. Surface a mirror
		// update failure into the log — without this, a STORE could ack a
		// flag change that the next FETCH from the same mirror won't show.
		finalFlags := updated.Flags
		if err := s.backend.Mirror.UpdateFlags(ctx, mailboxID, st.MessageID, finalFlags); err != nil {
			s.backend.logger().Printf("imap: mirror update flags %s: %v", st.MessageID, err)
		}
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
	return slices.ContainsFunc(list, func(f imap.Flag) bool {
		return strings.EqualFold(string(f), string(want))
	})
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
// for clients that only need RFC822.SIZE and a basic envelope.
//
// Future work — walk the actual MIME tree to populate BODYSTRUCTURE for
// multipart messages. Outline preserved below for whoever picks this up:
//
//   1. Parse the cached RFC822 bytes (or fetch them) using
//      github.com/emersion/go-message (already a transitive dep). The
//      reader returns nested mail.Entity values.
//   2. Recurse: for each mail.Entity, branch on
//      strings.HasPrefix(mediaType, "multipart/"). MultiPart subtype is
//      everything after the slash; collect children by reading
//      part.MultipartReader().NextPart() in a loop.
//      SinglePart fields (type/subtype/params/encoding/size) come from
//      the part headers; for text/* set Text.NumLines by counting LF in
//      the body bytes.
//   3. The fetch handler (writeMessage) already buffers body bytes when a
//      BODY[] section is requested, but BODYSTRUCTURE may be requested
//      WITHOUT BODY[] — we'd need to pre-fetch the body when
//      opts.BodyStructure != nil. To avoid two R2 round-trips, opportunistically
//      cache the parsed structure on the bridgeSession keyed by message id
//      (with a small LRU; 256 entries should cover all client UIs).
//   4. Synthesized fallback (no body available) stays as text/plain stub
//      so we never return NIL — clients that strictly require BODYSTRUCTURE
//      to be non-NIL still work.
//
// Shipping the stub keeps the bridge correct enough for Apple Mail / iOS
// (which only inspects multipart envelopes when displaying attachment
// chips). Outlook / Thunderbird tolerate the synthetic structure.
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
// HEADER.FIELDS / MIME / per-part fetches are future work that depends on
// the BODYSTRUCTURE MIME-tree walk above.
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
