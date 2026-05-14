import { PageCard } from '../layouts/PageCard.js';

export function Dashboard() {
  return (
    <PageCard
      decorative
      title="Dashboard"
      description="Operational overview. Cards and charts land in Phase I."
    >
      <p className="text-sm text-[var(--color-muted-foreground)]">
        Aggregates over messages and the webhook DLQ are wired against
        <code className="mx-1">/v1/admin/stats/overview</code>.
      </p>
    </PageCard>
  );
}
