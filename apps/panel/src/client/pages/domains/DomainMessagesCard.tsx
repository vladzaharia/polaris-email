// DomainMessagesCard — the messages list scoped to one domain.
//
// Thin wrapper around `MessagesListView` that locks the `?domain=` query
// param. The list view itself owns filters/table/pagination — this card
// adds the section chrome (title + border) so it slots into the Activity
// tab alongside AuditFeedCard + TransitionTimelineCard.
import { Mail } from 'lucide-react';
import { MessagesListView } from '../messages/MessagesListView.js';

export function DomainMessagesCard({
  domainId,
  domainName,
}: {
  domainId: string;
  domainName: string;
}) {
  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[var(--color-muted-foreground)]" aria-hidden>
            <Mail className="h-4 w-4" />
          </span>
          Message log
        </h2>
      </div>
      <MessagesListView scopedDomain={{ id: domainId, name: domainName }} />
    </section>
  );
}
