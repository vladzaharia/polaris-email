// Suppressions list page.
//
// Two tabs (Recipients / Senders) drive a server-side filter on `entity_type`.
// Additional client-side filters (reason / source / severity / scope / address
// search) push into the same query path. Mutations:
//   - "Add suppression" dialog → POST /api/admin/suppressions
//   - Per-row "Remove" → DELETE /api/admin/suppressions/:id
//
// Pagination is cursor-based (`next_cursor` returned by the API is the
// `created_at` of the last row); "Load more" appends.
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { AlertTriangle, AtSign, Plus, Tag, Workflow } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { FilterBar, type FilterSpec } from '../../components/FilterBar.js';
import { FilterAddressPicker, FilterEnumPicker } from '../../components/filters/index.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { useAllSenderAddresses } from '../../hooks/useAllSenderAddresses.js';
import { suppressionKeys } from '../../queryKeys.js';
import { formatRelative } from '../../lib/format.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { FormField } from '../../components/FormField.js';
import { AddressCombobox } from '../../components/AddressCombobox.js';
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

// Reason → Severity default mapping. Operators can still override either
// dropdown after the auto-fill — we just want the common case to be a
// single click. Anything missing falls back to "warn".
const REASON_DEFAULT_SEVERITY: Record<string, (typeof SEVERITIES)[number]> = {
  phishing_report: 'critical',
  arf_complaint: 'critical',
  spam_complaint: 'warn',
  sender_abuse_threshold: 'critical',
  hard_bounce: 'info',
  manual: 'warn',
  unsubscribe: 'info',
  role_account: 'info',
  invalid: 'info',
};

export function CreateSuppressionDialog({ entityType }: { entityType: 'recipient' | 'sender' }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const senderAddrs = useAllSenderAddresses();
  // For the 'sender' tab the mailbox-sender list is the canonical option set.
  // For the 'recipient' tab the same list is still a useful starting point
  // (e.g. internal-to-internal suppressions); ordering keeps it secondary.
  const addrSuggestions = [{ label: 'Mailbox senders', addresses: senderAddrs.data }] as const;
  const [reason, setReason] = useState<(typeof REASONS)[number]>('manual');
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('global');
  const [scopeTarget, setScopeTarget] = useState('');
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('warn');
  // Track whether the operator hand-set severity so we don't keep clobbering
  // their choice each time they tweak the reason dropdown.
  const [severityTouched, setSeverityTouched] = useState(false);
  const [notes, setNotes] = useState('');

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

  const reset = () => {
    setAddress('');
    setReason('manual');
    setScope('global');
    setScopeTarget('');
    setSeverity('warn');
    setSeverityTouched(false);
    setNotes('');
    create.reset();
  };

  // Clear the scope_target when scope flips back to 'global' so the
  // disabled field doesn't carry stale text into the POST body.
  const handleScopeChange = (next: (typeof SCOPES)[number]) => {
    setScope(next);
    if (next === 'global') setScopeTarget('');
  };

  const handleReasonChange = (next: (typeof REASONS)[number]) => {
    setReason(next);
    if (!severityTouched) {
      const suggested = REASON_DEFAULT_SEVERITY[next];
      if (suggested) setSeverity(suggested);
    }
  };

  const canSubmit = address.trim().length >= 3 && !create.isPending;
  const trimmedAddr = address.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" title="Add suppression" aria-label="Add suppression">
          <Plus className="h-4 w-4" />
        </Button>
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
        <div className="space-y-4">
          <FormField id="supp-addr" label="Address" required>
            <AddressCombobox
              id="supp-addr"
              value={address}
              onChange={setAddress}
              suggestions={addrSuggestions}
              placeholder="user@example.com"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="supp-reason" label="Reason">
              <Select
                value={reason}
                onValueChange={(v) => handleReasonChange(v as (typeof REASONS)[number])}
              >
                <SelectTrigger id="supp-reason">
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
            </FormField>
            <FormField id="supp-severity" label="Severity">
              <Select
                value={severity}
                onValueChange={(v) => {
                  setSeverity(v as (typeof SEVERITIES)[number]);
                  setSeverityTouched(true);
                }}
              >
                <SelectTrigger id="supp-severity">
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
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="supp-scope" label="Scope">
              <Select
                value={scope}
                onValueChange={(v) => handleScopeChange(v as (typeof SCOPES)[number])}
              >
                <SelectTrigger id="supp-scope">
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
            </FormField>
            <FormField id="supp-target" label="Scope target">
              <Input
                id="supp-target"
                value={scopeTarget}
                onChange={(e) => setScopeTarget(e.target.value)}
                placeholder={
                  scope === 'global' ? 'n/a — global scope' : 'mailbox / domain / sender id'
                }
                disabled={scope === 'global'}
              />
            </FormField>
          </div>
          <FormField id="supp-notes" label="Internal note (optional)">
            <Input
              id="supp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="why this row was added"
            />
          </FormField>
          {trimmedAddr ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Will block <span className="font-mono">{trimmedAddr}</span> at{' '}
              <span className="font-mono">{scope}</span> scope (
              <span className="font-mono">{severity}</span>).
            </p>
          ) : null}
          <ErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              await create.mutateAsync({
                entity_type: entityType,
                address: trimmedAddr,
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

export function SuppressionsTable({ entityType }: { entityType: 'recipient' | 'sender' }) {
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

  const filterSpecs: FilterSpec[] = [
    {
      id: 'reason',
      label: 'Reason',
      icon: Tag,
      value: reason || null,
      onChange: (next) => setReason(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={REASONS.map((r) => ({ value: r }))}
          value={reason || null}
          onChange={(v) => setReason(v ?? '')}
          close={close}
          anyLabel="All reasons"
        />
      ),
    },
    {
      id: 'severity',
      label: 'Severity',
      icon: AlertTriangle,
      value: severity || null,
      onChange: (next) => setSeverity(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={SEVERITIES.map((s) => ({ value: s }))}
          value={severity || null}
          onChange={(v) => setSeverity(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'source',
      label: 'Source',
      icon: Workflow,
      value: source || null,
      onChange: (next) => setSource(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterEnumPicker
          options={SOURCES.map((s) => ({ value: s }))}
          value={source || null}
          onChange={(v) => setSource(v ?? '')}
          close={close}
        />
      ),
    },
    {
      id: 'address',
      label: 'Address',
      icon: AtSign,
      value: search || null,
      onChange: (next) => setSearch(typeof next === 'string' ? next : ''),
      render: ({ close }) => (
        <FilterAddressPicker
          value={search || null}
          onChange={(v) => setSearch(v ?? '')}
          close={close}
          placeholder="exact address"
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterBar
        filters={filterSpecs}
        actions={
          <Button
            variant={includeDisabled ? 'default' : 'outline'}
            size="sm"
            onClick={() => setIncludeDisabled((v) => !v)}
          >
            {includeDisabled ? 'Hide disabled' : 'Show disabled'}
          </Button>
        }
      />

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
                  <StatusBadge kind="severity" value={r.severity} />
                </TableCell>
                <TableCell className="font-mono text-xs">{r.source}</TableCell>
                <TableCell title={r.created_at}>{formatRelative(r.created_at)}</TableCell>
                <TableCell title={r.expires_at ?? ''}>
                  <ExpiresCell expiresAt={r.expires_at} />
                </TableCell>
                <TableCell>
                  <StatusBadge kind="enabled" value={r.disabled_at ? 'disabled' : 'active'} />
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
      description="Do-not-send list, scoped per recipient or sender."
      decorative
      actions={<CreateSuppressionDialog entityType={tab} />}
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

// Expires-at column. Highlights rows that expire within the next 24h so
// operators see an imminent rollover at a glance.
function ExpiresCell({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span className="text-[var(--color-muted-foreground)]">never</span>;
  const ms = new Date(expiresAt).getTime() - Date.now();
  const imminent = ms > 0 && ms < 24 * 60 * 60 * 1000;
  const expired = ms <= 0;
  const className = expired
    ? 'text-[var(--color-muted-foreground)]'
    : imminent
      ? 'text-[var(--color-destructive)] font-medium'
      : '';
  return <span className={className}>{formatRelative(expiresAt)}</span>;
}
