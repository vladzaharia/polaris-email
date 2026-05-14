// Mailboxes list — table over v_mailbox_summary via GET /v1/admin/mailboxes.
//
// "Create mailbox" multi-step wizard is co-located here as a Dialog. The
// wizard persists in component state until the final step commits.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
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
import { Badge } from '../../components/ui/badge.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

interface MailboxRow {
  id: string;
  name: string;
  description: string | null;
  active_sender_count?: number;
  active_receiver_count?: number;
  created_at: string;
  disabled_at: string | null;
}

function CreateMailboxWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useAdminMutation<{ id: string }, { name: string; description?: string }>(
    (vars) => ({ path: '/api/admin/mailboxes', method: 'POST', body: vars }),
    { invalidateKeys: [['mailboxes']] },
  );
  const reset = () => {
    setStep(1);
    setName('');
    setDescription('');
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
        <Button>Create mailbox</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create mailbox — step {step} of 4</DialogTitle>
          <DialogDescription>
            Names, senders, receivers, then issue an optional credential.
          </DialogDescription>
        </DialogHeader>
        {step === 1 ? (
          <div className="space-y-3">
            <div>
              <Label htmlFor="mb-name">Name</Label>
              <Input id="mb-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="mb-desc">Description (optional)</Label>
              <Input
                id="mb-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
        ) : null}
        {step === 2 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Add senders after creation from the detail page — domain picker + address.
          </p>
        ) : null}
        {step === 3 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Receivers may be added after creation from the detail page.
          </p>
        ) : null}
        {step === 4 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Issue the first credential from the Credentials section once the mailbox exists.
          </p>
        ) : null}
        {create.error ? (
          <p className="text-sm text-[var(--color-destructive)]">{create.error.message}</p>
        ) : null}
        <DialogFooter>
          {step > 1 ? (
            <Button variant="outline" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : null}
          {step < 4 ? (
            <Button onClick={() => setStep(step + 1)} disabled={step === 1 && !name.trim()}>
              Next
            </Button>
          ) : (
            <Button
              onClick={async () => {
                await create.mutateAsync({
                  name: name.trim(),
                  description: description.trim() || undefined,
                });
                setOpen(false);
                reset();
              }}
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? 'Creating…' : 'Create mailbox'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MailboxesList() {
  const q = useAdminQuery<{ data: MailboxRow[] }>(['mailboxes'], '/api/admin/mailboxes');
  const rows = q.data?.data ?? [];
  return (
    <PageCard title="Mailboxes" description="Inbound + outbound mailbox registry." decorative>
      <div className="mb-4 flex justify-end">
        <CreateMailboxWizard />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.error ? (
        <p className="text-sm text-[var(--color-destructive)]">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No mailboxes yet. Use the button above to create one.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Senders</TableHead>
              <TableHead>Receivers</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to="/mailboxes/$id" params={{ id: r.id }} className="underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{r.description ?? '—'}</TableCell>
                <TableCell>{r.active_sender_count ?? 0}</TableCell>
                <TableCell>{r.active_receiver_count ?? 0}</TableCell>
                <TableCell className="text-xs">{r.created_at}</TableCell>
                <TableCell>
                  {r.disabled_at ? (
                    <Badge variant="destructive">disabled</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageCard>
  );
}
