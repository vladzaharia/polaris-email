// CF zone Configure modal — dry-run diff + selective apply.
//
// Lifecycle:
//   1. Open → POST /api/admin/cf-zones/:name/configure with `{ dry_run: true }`.
//   2. Render the diff (ops + warnings); operator picks which ops to apply.
//   3. Apply → POST again with `{ dry_run: false, op_kinds: [selected] }`.
//   4. After apply, the parent re-fetches the zone via the detail endpoint.
//
// `react-query` isn't used for the apply call because it's a one-shot inside
// the modal and we want to render `applied`/`failed` results inline before the
// modal closes.
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ErrorText } from '../../components/ErrorText.js';
import { apiFetch } from '../../lib/api.js';
import type {
  CfZoneConfigureApplyResponse,
  CfZoneConfigureDryRunResponse,
  ZoneConfigureOp,
  ZoneConfigureOpKind,
} from './types.js';

interface ConfigureModalProps {
  zoneName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful (or partially-successful) apply. */
  onApplied?: () => void;
}

export function ConfigureModal({ zoneName, open, onOpenChange, onApplied }: ConfigureModalProps) {
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<Error | null>(null);
  const [diff, setDiff] = useState<CfZoneConfigureDryRunResponse['diff'] | null>(null);
  const [selected, setSelected] = useState<Set<ZoneConfigureOpKind>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<Error | null>(null);
  const [applyResult, setApplyResult] = useState<CfZoneConfigureApplyResponse['result'] | null>(
    null,
  );

  // Reset state when the modal opens; pre-fetch the dry-run diff.
  useEffect(() => {
    if (!open) {
      setDiff(null);
      setSelected(new Set());
      setApplyResult(null);
      setApplyError(null);
      setDiffError(null);
      return;
    }
    setDiffLoading(true);
    apiFetch<CfZoneConfigureDryRunResponse>(
      `/api/admin/cf-zones/${encodeURIComponent(zoneName)}/configure`,
      {
        method: 'POST',
        body: JSON.stringify({ dry_run: true }),
      },
    )
      .then((r) => {
        setDiff(r.body.diff);
        // Default-check every op so the operator just hits Apply.
        setSelected(new Set(r.body.diff.ops.map((o) => o.kind)));
      })
      .catch((e) => setDiffError(e as Error))
      .finally(() => setDiffLoading(false));
  }, [open, zoneName]);

  function toggle(kind: ZoneConfigureOpKind) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  async function apply() {
    setApplying(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      const r = await apiFetch<CfZoneConfigureApplyResponse>(
        `/api/admin/cf-zones/${encodeURIComponent(zoneName)}/configure`,
        {
          method: 'POST',
          body: JSON.stringify({
            dry_run: false,
            op_kinds: Array.from(selected),
          }),
        },
      );
      setApplyResult(r.body.result);
      onApplied?.();
    } catch (e) {
      setApplyError(e as Error);
    } finally {
      setApplying(false);
    }
  }

  const hasOps = diff != null && diff.ops.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Configure {zoneName}</DialogTitle>
          <DialogDescription>
            Apply the operations needed to bring this zone into the polaris-email canonical
            configuration. Dry-run first; deselect any op you don&apos;t want to run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {diffLoading ? <Skeleton className="h-32 w-full" /> : null}
          <ErrorText error={diffError} />

          {diff && diff.warnings.length > 0 ? (
            <Alert variant="warning">
              <AlertTitle>Warnings</AlertTitle>
              <AlertDescription>
                <ul className="list-inside list-disc">
                  {diff.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {diff && !hasOps ? (
            <Alert variant="success">
              <AlertTitle>Already converged</AlertTitle>
              <AlertDescription>
                No operations needed — the zone matches the canonical configuration.
              </AlertDescription>
            </Alert>
          ) : null}

          {hasOps ? (
            <ul className="space-y-2">
              {diff!.ops.map((op) => (
                <li
                  key={op.kind}
                  className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-3"
                >
                  <Checkbox
                    id={`op-${op.kind}`}
                    checked={selected.has(op.kind)}
                    onCheckedChange={() => toggle(op.kind)}
                    disabled={applying || applyResult != null}
                  />
                  <div className="flex-1">
                    <label
                      htmlFor={`op-${op.kind}`}
                      className="block cursor-pointer text-sm font-medium"
                    >
                      {op.description}
                    </label>
                    <div className="mt-1 font-mono text-xs text-[var(--color-muted-foreground)]">
                      {op.kind}
                    </div>
                    {op.detail ? (
                      <details className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                        <summary className="cursor-pointer">detail</summary>
                        <pre className="mt-1 max-w-full overflow-x-auto rounded bg-[var(--color-muted)] p-2 font-mono text-xs">
                          {JSON.stringify(op.detail, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {applyResult ? <ApplyResultBlock result={applyResult} /> : null}

          {applyError ? <ErrorText error={applyError} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            {applyResult ? 'Close' : 'Cancel'}
          </Button>
          {applyResult ? null : (
            <Button
              onClick={() => void apply()}
              disabled={
                applying || !hasOps || selected.size === 0 || diffLoading || diffError != null
              }
            >
              {applying
                ? 'Applying…'
                : `Apply ${selected.size} op${selected.size === 1 ? '' : 's'}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplyResultBlock({ result }: { result: CfZoneConfigureApplyResponse['result'] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant={result.all_succeeded ? 'success' : 'warning'}>
          {result.all_succeeded ? (
            <>
              <Check className="h-3 w-3" aria-hidden /> all_succeeded
            </>
          ) : (
            <>
              <AlertTriangle className="h-3 w-3" aria-hidden /> partial
            </>
          )}
        </Badge>
      </div>
      {result.applied.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-[var(--color-success)]">
            Applied ({result.applied.length})
          </p>
          <ul className="mt-1 space-y-1 text-xs">
            {result.applied.map((op: ZoneConfigureOp) => (
              <li key={op.kind} className="flex items-center gap-2">
                <Check className="h-3 w-3 text-[var(--color-success)]" aria-hidden />
                <span className="font-mono">{op.kind}</span>
                <span className="text-[var(--color-muted-foreground)]">{op.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.failed.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-[var(--color-destructive)]">
            Failed ({result.failed.length})
          </p>
          <ul className="mt-1 space-y-1 text-xs">
            {result.failed.map((f) => (
              <li key={f.op.kind} className="flex items-start gap-2">
                <X className="mt-0.5 h-3 w-3 text-[var(--color-destructive)]" aria-hidden />
                <div>
                  <span className="font-mono">{f.op.kind}</span>
                  <span className="ml-2 text-[var(--color-destructive)]">{f.error}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
