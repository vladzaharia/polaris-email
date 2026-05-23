// Standalone /messages route — thin PageCard wrapper around MessagesListView.
// The list view itself lives in `MessagesListView.tsx` so it can also be
// embedded as a card on the domain detail Activity tab.
import { PageCard } from '../../layouts/PageCard.js';
import { MessagesListView } from './MessagesListView.js';

export function MessagesList() {
  return (
    <PageCard title="Messages" description="Inbound + outbound message log." decorative>
      <MessagesListView />
    </PageCard>
  );
}
