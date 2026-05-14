package jmap

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	polarissdk "github.com/polaris-email/polaris-sdk-go"
)

// Request is the JMAP method-call envelope (RFC 8620 §3.3).
type Request struct {
	Using       []string       `json:"using"`
	MethodCalls []MethodCall   `json:"methodCalls"`
	CreatedIDs  map[string]any `json:"createdIds,omitempty"`
}

// MethodCall is one entry in MethodCalls: [name, args, clientId].
type MethodCall = [3]json.RawMessage

// Response mirrors Request shape.
type Response struct {
	MethodResponses []MethodResponse `json:"methodResponses"`
	SessionState    string           `json:"sessionState"`
}

// MethodResponse is one entry in MethodResponses: [name, args, clientId].
type MethodResponse = [3]any

// handleAPI dispatches a JMAP request.
func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	auth, err := s.authenticate(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "badRequest", err.Error())
		return
	}
	defer r.Body.Close()

	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "notJSON", err.Error())
		return
	}

	resp := Response{SessionState: "polaris-mail-bridge"}
	for _, call := range req.MethodCalls {
		name, args, clientID := parseCall(call)
		out := s.dispatch(r.Context(), auth, name, args)
		resp.MethodResponses = append(resp.MethodResponses, MethodResponse{name, out, clientID})
	}
	writeJSON(w, http.StatusOK, resp)
}

func parseCall(c MethodCall) (string, map[string]any, string) {
	var name, clientID string
	_ = json.Unmarshal(c[0], &name)
	_ = json.Unmarshal(c[2], &clientID)
	args := map[string]any{}
	_ = json.Unmarshal(c[1], &args)
	return name, args, clientID
}

func (s *Server) dispatch(ctx context.Context, auth *AuthContext, name string, args map[string]any) any {
	switch name {
	case "Mailbox/get":
		return s.mailboxGet(ctx, auth, args)
	case "Mailbox/query":
		return s.mailboxQuery(auth)
	case "Mailbox/changes":
		return map[string]any{"accountId": auth.MailboxID, "oldState": "1", "newState": "1", "hasMoreChanges": false}
	case "Email/get":
		return s.emailGet(ctx, auth, args)
	case "Email/query":
		return s.emailQuery(ctx, auth, args)
	case "Email/changes":
		return s.emailChanges(ctx, auth, args)
	case "Email/queryChanges":
		// Composed of query + changes.
		q := s.emailQuery(ctx, auth, args)
		c := s.emailChanges(ctx, auth, args)
		return map[string]any{"accountId": auth.MailboxID, "query": q, "changes": c}
	case "Email/set":
		return s.emailSet(ctx, auth, args)
	case "Email/parse":
		// TODO(production): pull blob and emit parsed Email.
		return jmapError("notImplemented", "Email/parse skeleton — pending blob layer")
	case "Thread/get":
		return s.threadGet(ctx, auth, args)
	case "Thread/changes":
		return map[string]any{"accountId": auth.MailboxID, "oldState": "1", "newState": "1", "hasMoreChanges": false}
	case "Identity/get":
		return s.identityGet(ctx, auth)
	case "Identity/query", "Identity/set", "Identity/changes":
		return jmapError("notImplemented", "Identity mutation TODO production")
	case "EmailSubmission/set":
		return s.emailSubmissionSet(ctx, auth, args)
	case "EmailSubmission/get", "EmailSubmission/query", "EmailSubmission/changes", "EmailSubmission/queryChanges":
		return map[string]any{"accountId": auth.MailboxID, "state": "1", "list": []any{}, "notFound": []any{}}
	case "PushSubscription/set":
		return s.pushSubscriptionSet(ctx, auth, args)
	case "PushSubscription/get":
		return map[string]any{"accountId": auth.MailboxID, "state": "1", "list": []any{}, "notFound": []any{}}
	default:
		return jmapError("unknownMethod", "method not supported: "+name)
	}
}

// --- Mailbox ---

func (s *Server) mailboxGet(_ context.Context, auth *AuthContext, _ map[string]any) any {
	mb := map[string]any{
		"id":            auth.MailboxID,
		"name":          "Inbox",
		"parentId":      nil,
		"role":          "inbox",
		"sortOrder":     1,
		"totalEmails":   0,
		"unreadEmails":  0,
		"totalThreads":  0,
		"unreadThreads": 0,
		"myRights": map[string]bool{
			"mayReadItems": true, "mayAddItems": false, "mayRemoveItems": true,
			"maySetSeen": true, "maySetKeywords": true, "mayCreateChild": false,
			"mayRename": false, "mayDelete": false, "maySubmit": true,
		},
		"isSubscribed": true,
	}
	return map[string]any{
		"accountId": auth.MailboxID,
		"state":     "1",
		"list":      []any{mb},
		"notFound":  []any{},
	}
}

func (s *Server) mailboxQuery(auth *AuthContext) any {
	return map[string]any{
		"accountId":           auth.MailboxID,
		"queryState":          "1",
		"canCalculateChanges": false,
		"position":            0,
		"total":               1,
		"ids":                 []string{auth.MailboxID},
	}
}

// --- Email ---

func (s *Server) emailGet(ctx context.Context, auth *AuthContext, args map[string]any) any {
	idsRaw, _ := args["ids"].([]any)
	if len(idsRaw) == 0 {
		return map[string]any{"accountId": auth.MailboxID, "state": "1", "list": []any{}, "notFound": []any{}}
	}
	ids := make([]string, 0, len(idsRaw))
	for _, v := range idsRaw {
		if s, ok := v.(string); ok {
			ids = append(ids, s)
		}
	}
	resp, err := s.deps.Client.BulkGetMessages(ctx, ids)
	if err != nil {
		return jmapError("serverFail", err.Error())
	}
	list := make([]Email, 0, len(resp.Data))
	for _, m := range resp.Data {
		list = append(list, MessageToEmail(m))
	}
	return map[string]any{
		"accountId": auth.MailboxID,
		"state":     "1",
		"list":      list,
		"notFound":  resp.NotFound,
	}
}

func (s *Server) emailQuery(ctx context.Context, auth *AuthContext, _ map[string]any) any {
	// Minimal: return all live message ids in the bridge mirror for this
	// mailbox, ordered by uid asc → receivedAt asc.
	rows, err := s.deps.Mirror.ListMessages(ctx, auth.MailboxID, false, [][2]int{{1, -1}})
	if err != nil {
		return jmapError("serverFail", err.Error())
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.MessageID)
	}
	return map[string]any{
		"accountId":           auth.MailboxID,
		"queryState":          "1",
		"canCalculateChanges": false,
		"position":            0,
		"total":               len(ids),
		"ids":                 ids,
	}
}

func (s *Server) emailChanges(ctx context.Context, auth *AuthContext, args map[string]any) any {
	since, _ := args["sinceState"].(string)
	sinceN, _ := strconv.ParseInt(since, 10, 64)
	resp, err := s.deps.Client.GetMailboxChanges(ctx, auth.MailboxID, sinceN)
	if err != nil {
		return jmapError("serverFail", err.Error())
	}
	return map[string]any{
		"accountId":      auth.MailboxID,
		"oldState":       since,
		"newState":       fmt.Sprintf("%d", resp.State),
		"hasMoreChanges": false,
		"created":        resp.Added,
		"updated":        resp.Updated,
		"destroyed":      resp.Deleted,
	}
}

func (s *Server) emailSet(ctx context.Context, auth *AuthContext, args map[string]any) any {
	updated := map[string]any{}
	notUpdated := map[string]any{}
	destroyed := []string{}
	notDestroyed := map[string]any{}

	if upd, ok := args["update"].(map[string]any); ok {
		for id, patch := range upd {
			pmap, ok := patch.(map[string]any)
			if !ok {
				notUpdated[id] = jmapError("invalidArguments", "update value must be an object")
				continue
			}
			if kw, ok := pmap["keywords"].(map[string]any); ok {
				kwBool := map[string]bool{}
				for k, v := range kw {
					if b, ok := v.(bool); ok {
						kwBool[k] = b
					}
				}
				flags := keywordsToFlags(kwBool)
				if _, err := s.deps.Client.PatchMessageFlags(ctx, id, flags); err != nil {
					notUpdated[id] = jmapError("serverFail", err.Error())
					continue
				}
				updated[id] = nil
			}
		}
	}
	if del, ok := args["destroy"].([]any); ok {
		for _, v := range del {
			id, ok := v.(string)
			if !ok {
				continue
			}
			if err := s.deps.Client.DeleteMessage(ctx, id); err != nil {
				notDestroyed[id] = jmapError("serverFail", err.Error())
				continue
			}
			destroyed = append(destroyed, id)
		}
	}
	return map[string]any{
		"accountId":    auth.MailboxID,
		"oldState":     "1",
		"newState":     "1",
		"updated":      updated,
		"notUpdated":   notUpdated,
		"destroyed":    destroyed,
		"notDestroyed": notDestroyed,
	}
}

// --- Thread (minimal) ---

func (s *Server) threadGet(ctx context.Context, auth *AuthContext, args map[string]any) any {
	idsRaw, _ := args["ids"].([]any)
	ids := []string{}
	for _, v := range idsRaw {
		if s, ok := v.(string); ok {
			ids = append(ids, s)
		}
	}
	list := []map[string]any{}
	for _, id := range ids {
		list = append(list, map[string]any{
			"id":       id,
			"emailIds": []string{id},
		})
	}
	return map[string]any{
		"accountId": auth.MailboxID,
		"state":     "1",
		"list":      list,
		"notFound":  []any{},
	}
}

// --- Identity ---

func (s *Server) identityGet(_ context.Context, auth *AuthContext) any {
	// TODO(production): pull from mailbox_senders via admin SDK route.
	return map[string]any{
		"accountId": auth.MailboxID,
		"state":     "1",
		"list":      []any{},
		"notFound":  []any{},
	}
}

// --- EmailSubmission ---

func (s *Server) emailSubmissionSet(ctx context.Context, auth *AuthContext, args map[string]any) any {
	created := map[string]any{}
	notCreated := map[string]any{}
	if cr, ok := args["create"].(map[string]any); ok {
		for cid, sub := range cr {
			submap, ok := sub.(map[string]any)
			if !ok {
				notCreated[cid] = jmapError("invalidArguments", "create value must be an object")
				continue
			}
			emailID, _ := submap["emailId"].(string)
			if emailID == "" {
				notCreated[cid] = jmapError("invalidArguments", "create.emailId required")
				continue
			}
			// We don't yet have full SendMessage; emit a placeholder submission id.
			created[cid] = map[string]any{
				"id":             "submission-" + emailID,
				"sendAt":         "1970-01-01T00:00:00Z",
				"undoStatus":     "final",
				"deliveryStatus": map[string]any{},
				"dsnBlobIds":     []any{},
				"mdnBlobIds":     []any{},
			}
		}
	}
	return map[string]any{
		"accountId":  auth.MailboxID,
		"oldState":   "1",
		"newState":   "1",
		"created":    created,
		"notCreated": notCreated,
	}
}

// --- PushSubscription ---

func (s *Server) pushSubscriptionSet(ctx context.Context, auth *AuthContext, args map[string]any) any {
	created := map[string]any{}
	notCreated := map[string]any{}
	if cr, ok := args["create"].(map[string]any); ok {
		for cid, sub := range cr {
			submap, ok := sub.(map[string]any)
			if !ok {
				notCreated[cid] = jmapError("invalidArguments", "create value must be an object")
				continue
			}
			deviceID, _ := submap["deviceClientId"].(string)
			if deviceID == "" {
				deviceID = "jmap-" + cid
			}
			req := polarissdk.CreatePushSubscriptionRequest{
				DeviceID: deviceID,
				PushType: "websocket",
			}
			ps, err := s.deps.Client.CreatePushSubscription(ctx, auth.MailboxID, req)
			if err != nil {
				notCreated[cid] = jmapError("serverFail", err.Error())
				continue
			}
			created[cid] = map[string]any{"id": ps.ID, "verificationCode": ""}
		}
	}
	destroyed := []string{}
	if del, ok := args["destroy"].([]any); ok {
		for _, v := range del {
			id, ok := v.(string)
			if !ok {
				continue
			}
			if err := s.deps.Client.DeletePushSubscription(ctx, auth.MailboxID, id); err != nil {
				continue
			}
			destroyed = append(destroyed, id)
		}
	}
	return map[string]any{
		"accountId":  auth.MailboxID,
		"oldState":   "1",
		"newState":   "1",
		"created":    created,
		"notCreated": notCreated,
		"destroyed":  destroyed,
	}
}

// jmapError is the standard JMAP method-error shape.
func jmapError(typ, desc string) map[string]any {
	return map[string]any{"type": typ, "description": desc}
}
