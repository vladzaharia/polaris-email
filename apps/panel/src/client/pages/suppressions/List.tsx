// W1 — Suppressions list page.
//
// Two tabs (Recipients / Senders) drive a server-side filter on `entity_type`.
// Additional client-side filters (reason / source / severity / scope / address
// search) push into the same query path. Mutations:
//   - "Add suppression" dialog → POST /api/admin/suppressions (panel proxy
//     gates this through withApproval; the server enforces dual-admin via 428).
//   - Per-row "Remove" → DELETE /api/admin/suppressions/:id (approval-gated).
//
// Pagination is cursor-based (`next_cursor` returned by the API is the
// `created_at` of the last row); "Load more" appends.
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Badge } from '../../components/ui/badge.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { suppressionKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { DestructiveActionDialog } from '../../components/DestructiveActionDialog.js';

const REASONS = [
  'hard_bounce',
  'spam_complaint',
  'unsubscribe',
  'manual',
  'arf_complaint',
  'phishing_report',
  'sender_abuse_threshold',
  'role_account',
  'invalid',
] as const;

const SOURCES = [
  'cf_email_service',
  'arf_inbox',
  'one_click',
  'cli',
  'panel',
  'import',
  'sender_threshold_cron',
  'llm_triage',
] as const;

const SEVERITIES = ['info', 'warn', 'critical'] as const;
const SCOPES = ['global', 'domain', 'mailbox', 'sender_address'] as const;

interface SuppressionRow {
  id: string;
  entity_type: 'recipient' | 'sender';
  address_normalized: string;
  scope: string;
  scope_target: string | null;
  reason: string;
  source: string;
  severity: 'info' | 'warn' | 'critical';
  created_at: string;
  expires_at: string | null;
  disabled_at: string | null;
  notes: string | null;
}

function severityBadgeVariant(s: SuppressionRow['severity']) {
  return s === 'critical' ? 'destructive' : s === 'warn' ? 'warning' : 'secondary';
}

function CreateSuppressionDialog({ entityType }: { entityType: 'recipient' | 'sender' }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('manual');
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('global');
  const [scopeTarget, setScopeTarget] = useState('');
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('warn');
  const [notes, setNotes] = useState('');
  const [needsApproval, setNeedsApproval] = useState(false);

  const create = useAdminMutation<
    { id: string },
    {
      entity_type: 'recipient' | 'sender';
      address: string;
      reason: string;
      scope: string;
      scope_target?: string | null;
      severity: string;
      notes?: string | null;
      source: string;
    }
  >((vars) => ({ path: '/api/admin/suppressions', method: 'POST', body: vars }), {
    invalidateKeys: [suppressionKeys.all],
    silent: true,
  });
  if (
    create.error &&
    (create.error as { code?: string }).code === 'approval_required' &&
    !needsApproval
  ) {
    setNeedsApproval(true);
  }

  const reset = () => {
    setAddress('');
    setReason('manual');
    setScope('global');
    setScopeTarget('');
    setSeverity('warn');
    setNotes('');
    setNeedsApproval(false);
    create.reset();
  };

  const canSubmit = address.trim().length >= 3 && !create.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Add suppression</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Add {entityType === 'recipient' ? 'recipient' : 'sender'} suppression
          </DialogTitle>
          <DialogDescription>
            {entityType === 'recipient'
              ? 'Block sending TO this address. Use sparingly — most recipient suppressions arrive automatically via ARF, hard bounces, or one-click unsubscribes.'
              : 'Block sending FROM this principal. Use this to manually pause a sender that ops believes is misbehaving; W2c will auto-fire suppression at scale.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="supp-addr">Address</Label>
            <Input
              id="supp-addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Reason</Label>
              <Select
                value={reason}
                onValueChange={(v) => setReason(v as (typeof REASONS)[number])}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Severity</Label>
              <Select
                value={severity}
                onValueChange={(v) => setSeverity(v as (typeof SEVERITIES)[number])}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as (typeof SCOPES)[number])}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="supp-target">Scope target</Label>
              <Input
                id="supp-target"
                value={scopeTarget}
                onChange={(e) => setScopeTarget(e.target.value)}
                placeholder={scope === 'global' ? 'leave blank' : 'mailbox / domain / sender id'}
                disabled={scope === 'global'}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="supp-notes">Notes</Label>
            <Input
              id="supp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="reason this row was added"
            />
          </div>
          {needsApproval ? (
            <ErrorText error="Approval required — another admin must co-sign this action." />
          ) : (
            <ErrorText error={create.error} />
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              await create.mutateAsync({
                entity_type: entityType,
                address: address.trim(),
                reason,
                scope,
                scope_target: scope === 'global' ? null : scopeTarget.trim() || null,
                severity,
                notes: notes.trim() || null,
                source: 'panel',
              });
              setOpen(false);
              reset();
            }}
            disabled={!canSubmit}
          >
            {create.isPending ? 'Adding…' : 'Add suppression'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowActions({ row }: { row: SuppressionRow }) {
  const [open, setOpen] = useState(false);
  const remove = useAdminMutation<{ id: string; disabled_at: string }, { id: string }>(
    (vars) => ({
      path: `/api/admin/suppressions/${vars.id}?reason=operator_override`,
      method: 'DELETE',
    }),
    { invalidateKeys: [suppressionKeys.all], silent: true },
  );
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <DestructiveActionDialog
        open={open}
        onOpenChange={setOpen}
        action={`Remove suppression for ${row.address_normalized}`}
        reversible={true}
        blastRadius={[
          row.entity_type === 'sender'
            ? 'This sender will be able to send mail again immediately.'
            : 'Mail to this recipient will resume on the next send.',
          'The suppression row stays in the audit log; you can re-add it any time.',
          row.severity === 'critical'
            ? 'WARNING: this row was flagged critical — phishing/legal/threshold-driven.'
            : 'Severity: ' + row.severity,
        ]}
        onConfirm={async () => {
          await remove.mutateAsync({ id: row.id });
        }}
        isPending={remove.isPending}
      />
    </>
  );
}

function SuppressionsTable({ entityType }: { entityType: 'recipient' | 'sender' }) {
  const [reason, setReason] = useState<string>('');
  const [severity, setSeverity] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [includeDisabled, setIncludeDisabled] = useState(false);

  const filters = useMemo(() => {
    const f: Record<string, string> = { entity_type: entityType };
    if (reason) f.reason = reason;
    if (severity) f.severity = severity;
    if (source) f.source = source;
    if (search) f.address = search;
    if (includeDisabled) f.include_disabled = '1';
    return f;
  }, [entityType, reason, severity, source, search, includeDisabled]);

  const path = useMemo(() => {
    const q = new URLSearchParams(filters as Record<string, string>);
    return `/api/admin/suppressions?${q.toString()}`;
  }, [filters]);

  const q = useAdminQuery<{ data: SuppressionRow[]; next_cursor: string | null }>(
    suppressionKeys.list(filters),
    path,
  );

  const rows = q.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <div>
          <Label>Reason</Label>
          <Select value={reason || 'all'} onValueChange={(v) => setReason(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Severity</Label>
          <Select
            value={severity || 'all'}
            onValueChange={(v) => setSeverity(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Source</Label>
          <Select value={source || 'all'} onValueChange={(v) => setSource(v === 'all' ? '' : v)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-1">
          <Label>Search address</Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="exact address"
          />
        </div>
        <div className="flex items-end gap-2">
          <Button
            variant={includeDisabled ? 'default' : 'outline'}
            onClick={() => setIncludeDisabled((v) => !v)}
          >
            {includeDisabled ? 'Hide disabled' : 'Show disabled'}
          </Button>
          <CreateSuppressionDialog entityType={entityType} />
        </div>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={`No ${entityType} suppressions match`}
          description="Tweak the filters or add one manually using the button above."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    to="/suppressions/$id"
                    params={{ id: r.id }}
                    className="underline"
                    title={r.address_normalized}
                  >
                    {r.address_normalized}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.reason}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.scope}
                  {r.scope_target ? `:${r.scope_target.slice(0, 8)}…` : ''}
                </TableCell>
                <TableCell>
                  <Badge variant={severityBadgeVariant(r.severity)}>{r.severity}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.source}</TableCell>
                <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                <TableCell title={r.expires_at ?? ''}>
                  {r.expires_at ? formatRelative(r.expires_at) : 'never'}
                </TableCell>
                <TableCell>
                  {r.disabled_at ? (
                    <Badge variant="secondary">disabled</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
                <TableCell>{!r.disabled_at && <RowActions row={r} />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function SuppressionsList() {
  const [tab, setTab] = useState<'recipient' | 'sender'>('recipient');
  return (
    <PageCard
      title="Suppressions"
      description="Bi-directional do-not-send list. Recipients tab blocks mail TO; Senders tab blocks mail FROM."
      decorative
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'recipient' | 'sender')}>
        <TabsList>
          <TabsTrigger value="recipient">Recipients</TabsTrigger>
          <TabsTrigger value="sender">Senders</TabsTrigger>
        </TabsList>
        <TabsContent value="recipient" className="mt-6">
          <SuppressionsTable entityType="recipient" />
        </TabsContent>
        <TabsContent value="sender" className="mt-6">
          <SuppressionsTable entityType="sender" />
        </TabsContent>
      </Tabs>
    </PageCard>
  );
}
