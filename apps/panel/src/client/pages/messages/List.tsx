import { PageCard } from '../../layouts/PageCard.js';

export function MessagesList() {
  return (
    <PageCard title="Messages" description="Inbound + outbound message log.">
      <p className="text-sm text-[var(--color-muted-foreground)]">Phase I implements this view.</p>
    </PageCard>
  );
}
