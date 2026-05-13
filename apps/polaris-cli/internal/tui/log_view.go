package tui

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/client"
)

// SSEStream connects to /v1/admin/logs/stream and turns each `data:` event
// into a LogMsg.
//
// The returned StreamFunc reads exactly one event per invocation; the model
// re-arms it after each successful read.
func SSEStream(ctx context.Context, c *client.Client, logType, domain string) (StreamFunc, func(), error) {
	q := url.Values{}
	q.Set("type", logType)
	q.Set("follow", "true")
	if domain != "" {
		q.Set("domain", domain)
	}
	req, err := c.Request(ctx, "GET", "/v1/admin/logs/stream", q, nil)
	if err != nil {
		return nil, func() {}, err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, func() {}, err
	}
	if resp.StatusCode >= 300 {
		_ = resp.Body.Close()
		return nil, func() {}, fmt.Errorf("logs stream: HTTP %d", resp.StatusCode)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	stream := func() tea.Cmd {
		return func() tea.Msg {
			return readOneEvent(scanner, resp.Body)
		}
	}
	closer := func() { _ = resp.Body.Close() }
	return stream, closer, nil
}

func readOneEvent(s *bufio.Scanner, r io.Closer) tea.Msg {
	var dataLines []string
	for s.Scan() {
		line := s.Text()
		if line == "" {
			if len(dataLines) == 0 {
				continue
			}
			payload := strings.Join(dataLines, "\n")
			var entry client.LogEntry
			if err := json.Unmarshal([]byte(payload), &entry); err != nil {
				return StreamErrMsg{Err: fmt.Errorf("decode SSE payload: %w", err)}
			}
			return LogMsg{Entry: entry}
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := s.Err(); err != nil {
		return StreamErrMsg{Err: err}
	}
	return StreamErrMsg{Err: io.EOF}
}
