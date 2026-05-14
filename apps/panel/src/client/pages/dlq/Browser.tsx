import { PageCard } from '../../layouts/PageCard.js';

export function DlqBrowser() {
  return (
    <PageCard title="Dead-letter queue" description="Failed webhook deliveries and replays.">
      <p className="text-sm text-[var(--color-muted-foreground)]">Phase I implements this view.</p>
    </PageCard>
  );
}
