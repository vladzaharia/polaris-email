// Routing detail — surfaces the editable form, but receiver IDs aren't
// globally addressable in our current admin API (everything is nested under
// /v1/admin/mailboxes/:id/receivers/:receiverId). The deep-link here lets the
// operator copy the receiver id; full editing flows through the mailbox
// detail page.
import { useParams } from '@tanstack/react-router';
import { PageCard } from '../../layouts/PageCard.js';

export function RoutingDetail() {
  const { id } = useParams({ from: '/routing/$id' });
  return (
    <PageCard title="Routing rule" description={id} decorative>
      <p className="text-sm">
        Receiver rules are managed inline from the mailbox detail page. The receiver id is{' '}
        <code className="font-mono">{id}</code>.
      </p>
      <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
        Use the Mailbox detail page (Receivers section) to edit or disable this row.
      </p>
    </PageCard>
  );
}
