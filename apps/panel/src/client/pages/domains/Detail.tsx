import { PageCard } from '../../layouts/PageCard.js';

export function DomainDetail() {
  return (
    <PageCard title="Domain" description="DKIM keys, MX records, SPF/DMARC status.">
      <p className="text-sm text-[var(--color-muted-foreground)]">Phase I implements this view.</p>
    </PageCard>
  );
}
