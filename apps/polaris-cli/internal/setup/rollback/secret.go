package rollback

import (
	"context"
	"fmt"
	"time"

	"github.com/vladzaharia/polaris-email/apps/polaris-cli/internal/setup/secrets"
)

// SecretOptions gates RollbackSecret.
type SecretOptions struct {
	// Archive is the on-disk .secrets.archive.json reader. Required.
	Archive *Archive
	// Pusher fans the archived value out to every recorded service.
	// Optional: defaults to secrets.WranglerPusher{} when nil. Tests
	// pass a stub.
	Pusher secrets.Pusher
	// Recorder owns secrets.created.json. After a successful rollback
	// we re-stamp the sha256 of the restored value so audit shows the
	// rollback landed. Optional.
	Recorder *secrets.Recorder
	// Reporter receives one Step/StepDone callback per service the
	// secret is re-pushed to. Optional.
	Reporter secrets.Reporter
}

// RollbackSecret reads the previously-archived value for `name` and
// re-pushes it via wrangler to every service the archive recorded for
// that secret. Returns a clear error if no archive entry exists.
//
// The archive is left in place after a successful rollback — this is
// deliberate: rolling back a rollback (back to the rotated-to value)
// is a legitimate flow, and the archive must still describe what the
// last "good" state was. A future rotation overwrites the archive
// entry with 1-deep retention.
//
// On partial failure (some services push, others fail) the function
// returns an error citing exactly which services failed; the
// successful pushes already landed, and re-running RollbackSecret is
// idempotent.
func RollbackSecret(ctx context.Context, name string, opts SecretOptions) error {
	if name == "" {
		return fmt.Errorf("rollback: secret name required")
	}
	if opts.Archive == nil {
		return fmt.Errorf("rollback: archive required")
	}
	services, value, ok, err := opts.Archive.Get(name)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("rollback: no archived value for secret %q — "+
			"run `setup infra secrets rotate %s` first or restore from your operator vault", name, name)
	}
	if len(services) == 0 {
		return fmt.Errorf("rollback: archived entry for %q lists no services", name)
	}
	pusher := opts.Pusher
	if pusher == nil {
		pusher = secrets.WranglerPusher{}
	}

	rep := opts.Reporter
	if rep != nil {
		rep.Start(len(services))
		defer rep.Done()
	}

	var failures []string
	for _, svc := range services {
		if err := ctx.Err(); err != nil {
			return err
		}
		if rep != nil {
			rep.Step(name, svc)
		}
		err := pusher.Push(ctx, svc, name, value)
		if rep != nil {
			rep.StepDone(name, svc, err)
		}
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s/%s: %v", svc, name, err))
			continue
		}
		if opts.Recorder != nil {
			// Use Upsert so the sha256 in the recorder reflects the
			// restored (old) value, not whatever was last there.
			_ = opts.Recorder.Upsert(svc, name, value, time.Now().UTC())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("rollback secret %s: %d failure(s):\n  %s",
			name, len(failures), joinLines(failures))
	}
	return nil
}

// joinLines mirrors strings.Join with a per-line indent.
func joinLines(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += "\n  "
		}
		out += s
	}
	return out
}
