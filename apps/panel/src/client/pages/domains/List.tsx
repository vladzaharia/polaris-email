// Domains list — GET /v1/admin/domains. Inbound/outbound toggles and DKIM
// rotate live on the detail page, but the initial create + the inbound/outbound
// defaults are wired here.
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageCard } from '../../layouts/PageCard.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { domainKeys } from '../../queryKeys.js';
import { apiFetch } from '../../lib/api.js';
import { ErrorText } from '../../components/ErrorText.js';
import { EmptyState } from '../../components/EmptyState.js';

interface DomainRow {
  id: string;
  name: string;
  status: 'pending' | 'verified' | 'failed' | 'disabled' | string;
  dkim_selector: string | null;
  inbound_enabled?: number;
  outbound_enabled?: number;
}

function AddDomainDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // Defaults match the backend: outbound on (the common case for issuing
  // senders), inbound off until the operator opts in.
  const [inbound, setInbound] = useState(false);
  const [outbound, setOutbound] = useState(true);
  const create = useAdminMutation<{ id: string }, { name: string }>(
    (vars) => ({ path: '/api/admin/domains', method: 'POST', body: vars }),
    { invalidateKeys: [domainKeys.all], silent: true },
  );

  const reset = () => {
    setName('');
    setInbound(false);
    setOutbound(true);
    create.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Add domain</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add domain</DialogTitle>
          <DialogDescription>
            Registers a mail-domain with default DKIM selector. Inbound + outbound flags can be
            flipped on the detail page later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="dom-name">Domain name</Label>
            <Input
              id="dom-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme.example"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="dom-in" checked={inbound} onCheckedChange={setInbound} />
            <Label htmlFor="dom-in">Enable inbound (accept mail for this domain)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="dom-out" checked={outbound} onCheckedChange={setOutbound} />
            <Label htmlFor="dom-out">Enable outbound (allow this domain in From)</Label>
          </div>
          <ErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || create.isPending}
            onClick={async () => {
              const r = await create.mutateAsync({ name: name.trim() });
              // The create endpoint defaults to inbound=0, outbound=1. Fire the
              // toggle endpoints only if the operator picked something else.
              const toggles: Array<Promise<unknown>> = [];
              if (inbound) {
                toggles.push(
                  apiFetch(`/api/admin/domains/${r.id}/inbound/enable`, { method: 'POST' }),
                );
              }
              if (!outbound) {
                toggles.push(
                  apiFetch(`/api/admin/domains/${r.id}/outbound/disable`, { method: 'POST' }),
                );
              }
              if (toggles.length > 0) {
                // Best-effort. Toast surfaces any toggle failure but the
                // domain itself is already created — operator can flip from
                // detail page.
                try {
                  await Promise.all(toggles);
                } catch {
                  /* swallow — toggles can be retried on detail */
                }
              }
              setOpen(false);
              reset();
            }}
          >
            {create.isPending ? 'Adding…' : 'Add domain'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DomainsList() {
  const q = useAdminQuery<{ data: DomainRow[] }>(domainKeys.list(), '/api/admin/domains');
  const rows = q.data?.data ?? [];
  return (
    <PageCard title="Domains" description="Sender/recipient domain registry." decorative>
      <div className="mb-4 flex justify-end">
        <AddDomainDialog />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No domains registered"
          description="Register a sender or recipient domain before issuing senders or accepting inbound mail."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Inbound</TableHead>
              <TableHead>Outbound</TableHead>
              <TableHead>DKIM</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to="/domains/$id" params={{ id: r.id }} className="underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{r.inbound_enabled ? 'on' : 'off'}</TableCell>
                <TableCell>{r.outbound_enabled ? 'on' : 'off'}</TableCell>
                <TableCell className="font-mono text-xs">{r.dkim_selector ?? '—'}</TableCell>
                <TableCell>
                  <StatusBadge kind="domain" value={r.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
