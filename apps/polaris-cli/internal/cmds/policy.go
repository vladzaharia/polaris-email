// 0019 — `polaris-email policy` CLI subtree.
//
// Mirrors the admin REST surface in services/api/src/routes/admin/moderation.ts:
//
//   polaris-email policy decisions list [--verdict ...] [--direction ...] [--stream ...]
//   polaris-email policy held list      [--direction ...] [--status open|released|dropped|all]
//   polaris-email policy held show      <held_id>
//   polaris-email policy held release   <held_id> [--as legit]
//   polaris-email policy held drop      <held_id> [--as phishing|spam|marketing]
//   polaris-email policy held reclassify <held_id> --verdict <v> [--notes ...]
//
// Release / drop / reclassify all write a moderation_feedback row that
// feeds the inbound LLM's few-shot prompt on the next daily KV refresh.
package cmds

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/output"
)

type PolicyDecision struct {
	ID                   string    `json:"id"`
	MessageID            *string   `json:"message_id"`
	Direction            string    `json:"direction"`
	StreamType           string    `json:"stream_type"`
	Verdict              string    `json:"verdict"`
	TotalScore           int       `json:"total_score"`
	HeuristicReasonsJSON string    `json:"heuristic_reasons_json"`
	LlmInvoked           int       `json:"llm_invoked"`
	LlmLabel             *string   `json:"llm_label"`
	LlmConfidence        *float64  `json:"llm_confidence"`
	LlmBudgetState       *string   `json:"llm_budget_state"`
	DecidedAt            time.Time `json:"decided_at"`
}

type HeldMessage struct {
	ID             string    `json:"id"`
	MessageID      *string   `json:"message_id"`
	Direction      string    `json:"direction"`
	StreamType     string    `json:"stream_type"`
	DecisionID     string    `json:"decision_id"`
	RawMimeR2Key   string    `json:"raw_mime_r2_key"`
	HoldReason     string    `json:"hold_reason"`
	HoldUntil      string    `json:"hold_until"`
	ReleasedAt     *string   `json:"released_at"`
	ReleasedBy     *string   `json:"released_by"`
	ReleasedAction *string   `json:"released_action"`
	CreatedAt      time.Time `json:"created_at"`
}

type policyDecisionListResponse struct {
	Data []PolicyDecision `json:"data"`
}

type heldListResponse struct {
	Data []HeldMessage `json:"data"`
}

type heldDetailResponse struct {
	Held     HeldMessage    `json:"held"`
	Decision PolicyDecision `json:"decision"`
}

func newPolicyCmd() *cobra.Command {
	c := &cobra.Command{Use: "policy", Short: "Inspect + moderate the hybrid policy engine"}
	c.AddCommand(newPolicyDecisionsCmd(), newPolicyHeldCmd())
	return c
}

func newPolicyDecisionsCmd() *cobra.Command {
	c := &cobra.Command{Use: "decisions", Short: "Policy decision log"}
	c.AddCommand(policyDecisionsListCmd())
	return c
}

func newPolicyHeldCmd() *cobra.Command {
	c := &cobra.Command{Use: "held", Short: "Moderation queue + actions"}
	c.AddCommand(
		policyHeldListCmd(),
		policyHeldShowCmd(),
		policyHeldReleaseCmd(),
		policyHeldDropCmd(),
		policyHeldReclassifyCmd(),
	)
	return c
}

func policyDecisionsListCmd() *cobra.Command {
	var verdict, direction, stream, since string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List policy decisions",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if verdict != "" {
				q.Set("verdict", verdict)
			}
			if direction != "" {
				q.Set("direction", direction)
			}
			if stream != "" {
				q.Set("stream_type", stream)
			}
			if since != "" {
				q.Set("since", since)
			}
			path := "/v1/admin/policy/decisions"
			if encoded := q.Encode(); encoded != "" {
				path += "?" + encoded
			}
			var out policyDecisionListResponse
			if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{
				"ID", "VERDICT", "DIR", "STREAM", "SCORE", "LLM", "DECIDED",
			}}
			for _, d := range out.Data {
				llm := "skipped"
				if d.LlmInvoked == 1 {
					label := "?"
					if d.LlmLabel != nil {
						label = *d.LlmLabel
					}
					llm = label
				}
				t.Rows = append(t.Rows, []string{
					d.ID, d.Verdict, d.Direction, d.StreamType,
					fmt.Sprintf("%d", d.TotalScore), llm, d.DecidedAt.Format(time.RFC3339),
				})
			}
			return EmitTable(t, out.Data)
		},
	}
	cmd.Flags().StringVar(&verdict, "verdict", "", "pass|pass_warn|hold|block")
	cmd.Flags().StringVar(&direction, "direction", "", "inbound|outbound")
	cmd.Flags().StringVar(&stream, "stream", "", "inbound|transactional|marketing|agent")
	cmd.Flags().StringVar(&since, "since", "", "ISO timestamp lower bound")
	return cmd
}

func policyHeldListCmd() *cobra.Command {
	var direction, status string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List held messages",
		RunE: func(_ *cobra.Command, _ []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if direction != "" {
				q.Set("direction", direction)
			}
			if status != "" {
				q.Set("status", status)
			}
			path := "/v1/admin/policy/held"
			if encoded := q.Encode(); encoded != "" {
				path += "?" + encoded
			}
			var out heldListResponse
			if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &out); err != nil {
				return err
			}
			t := &output.Table{Headers: []string{
				"HELD_ID", "DIR", "STREAM", "REASON", "STATUS", "CREATED",
			}}
			for _, h := range out.Data {
				st := "open"
				if h.ReleasedAction != nil {
					st = *h.ReleasedAction
				}
				t.Rows = append(t.Rows, []string{
					h.ID, h.Direction, h.StreamType, truncate(h.HoldReason, 60), st,
					h.CreatedAt.Format(time.RFC3339),
				})
			}
			return EmitTable(t, out.Data)
		},
	}
	cmd.Flags().StringVar(&direction, "direction", "", "inbound|outbound")
	cmd.Flags().StringVar(&status, "status", "open", "open|released|dropped|all")
	return cmd
}

func policyHeldShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <held_id>",
		Short: "Show a held message's decision detail",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			var out heldDetailResponse
			path := "/v1/admin/policy/held/" + url.PathEscape(args[0])
			if err := cl.DoJSON(CtxBackground(), "GET", path, nil, nil, &out); err != nil {
				return err
			}
			// Always pretty-print the decision for the operator-readable
			// reason vector — there's no useful table form for the JSON.
			pretty, _ := json.MarshalIndent(out, "", "  ")
			fmt.Println(string(pretty))
			return nil
		},
	}
}

func policyHeldReleaseCmd() *cobra.Command {
	var asLabel, notes string
	cmd := &cobra.Command{
		Use:   "release <held_id>",
		Short: "Release a held message (re-injects inbound or re-enqueues outbound)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			action := "released_as_legit"
			if asLabel != "" && asLabel != "legit" {
				action = asLabel
			}
			body := map[string]string{"action": action}
			if notes != "" {
				body["notes"] = notes
			}
			path := "/v1/admin/policy/held/" + url.PathEscape(args[0]) + "/release"
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, body, &out); err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(out, "", "  ")
			fmt.Println(string(pretty))
			return nil
		},
	}
	cmd.Flags().StringVar(&asLabel, "as", "legit", "released_as_legit|reclassified")
	cmd.Flags().StringVar(&notes, "notes", "", "Operator notes (recorded in moderation_feedback)")
	return cmd
}

func policyHeldDropCmd() *cobra.Command {
	var asLabel, notes string
	cmd := &cobra.Command{
		Use:   "drop <held_id>",
		Short: "Drop a held message (also records the feedback verdict for the LLM)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			label := "dropped_as_phishing"
			switch asLabel {
			case "phishing":
				label = "dropped_as_phishing"
			case "spam":
				label = "dropped_as_spam"
			case "marketing":
				label = "dropped_as_marketing"
			}
			body := map[string]string{"action": label}
			if notes != "" {
				body["notes"] = notes
			}
			path := "/v1/admin/policy/held/" + url.PathEscape(args[0]) + "/drop"
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, body, &out); err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(out, "", "  ")
			fmt.Println(string(pretty))
			return nil
		},
	}
	cmd.Flags().StringVar(&asLabel, "as", "phishing", "phishing|spam|marketing")
	cmd.Flags().StringVar(&notes, "notes", "", "Operator notes (recorded in moderation_feedback)")
	return cmd
}

func policyHeldReclassifyCmd() *cobra.Command {
	var verdict, notes string
	cmd := &cobra.Command{
		Use:   "reclassify <held_id>",
		Short: "Record a reclassification without releasing/dropping",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if verdict == "" {
				return fmt.Errorf("--verdict required")
			}
			cl, err := MakeClient()
			if err != nil {
				return err
			}
			body := map[string]string{"corrected_verdict": verdict}
			if notes != "" {
				body["notes"] = notes
			}
			path := "/v1/admin/policy/held/" + url.PathEscape(args[0]) + "/reclassify"
			var out map[string]any
			if err := cl.DoJSON(CtxBackground(), "POST", path, nil, body, &out); err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(out, "", "  ")
			fmt.Println(string(pretty))
			return nil
		},
	}
	cmd.Flags().StringVar(&verdict, "verdict", "", "corrected verdict")
	cmd.Flags().StringVar(&notes, "notes", "", "Operator notes")
	return cmd
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
