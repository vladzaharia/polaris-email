import { PageCard } from '../../layouts/PageCard.js';

export function DaemonDetail() {
  return (
    <PageCard title="Daemon" description="Status, heartbeat, rotate token.">
      <p className="text-sm text-[var(--color-muted-foreground)]">Phase I implements this view.</p>
    </PageCard>
  );
}
