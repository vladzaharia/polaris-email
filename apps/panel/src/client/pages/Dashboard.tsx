// Dashboard — operational overview backed by GET /v1/admin/stats/overview.
//
// Cards: cardinalities (mailboxes, domains by status, senders, credentials,
// webhook-subs). Tabs switch the 24h / 7d / 30d time window for the message
// counts and DLQ depth aggregate.
import { useState } from 'react';
import { PageCard } from '../layouts/PageCard.js';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../components/ui/card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Skeleton } from '../components/ui/skeleton.js';
import { useAdminQuery } from '../hooks/useAdminApi.js';
import { statsKeys } from '../queryKeys.js';

interface StatsOverview {
  window: '24h' | '7d' | '30d';
  cardinality: {
    mailboxes: number;
    domains_verified: number;
    domains_pending: number;
    domains_failed: number;
    senders: number;
    credentials_api_key: number;
    credentials_smtp: number;
    webhook_subs: number;
  };
  messages: {
    sent: number;
    delivered: number;
    failed: number;
    bounced: number;
    inbound_received: number;
  };
  dlq_depth: number;
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0 text-xs text-[var(--color-muted-foreground)]">
          {hint}
        </CardContent>
      ) : null}
    </Card>
  );
}

function WindowedCards({ window }: { window: '24h' | '7d' | '30d' }) {
  const q = useAdminQuery<StatsOverview>(
    statsKeys.overview(window),
    `/api/admin/stats/overview?window=${window}`,
  );
  if (q.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (q.error) {
    return (
      <p className="text-sm text-[var(--color-destructive)]">
        Failed to load stats: {q.error.message}
      </p>
    );
  }
  const d = q.data!;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <StatCard label="Mailboxes" value={d.cardinality.mailboxes} />
        <StatCard
          label="Domains verified"
          value={d.cardinality.domains_verified}
          hint={`${d.cardinality.domains_pending} pending / ${d.cardinality.domains_failed} failed`}
        />
        <StatCard label="Senders" value={d.cardinality.senders} />
        <StatCard
          label="Credentials"
          value={d.cardinality.credentials_api_key + d.cardinality.credentials_smtp}
          hint={`${d.cardinality.credentials_api_key} api / ${d.cardinality.credentials_smtp} smtp`}
        />
        <StatCard label="Webhook subs" value={d.cardinality.webhook_subs} />
        <StatCard label="DLQ depth" value={d.dlq_depth} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label={`Sent (${window})`} value={d.messages.sent} />
        <StatCard label={`Delivered (${window})`} value={d.messages.delivered} />
        <StatCard label={`Failed (${window})`} value={d.messages.failed} />
        <StatCard label={`Bounced (${window})`} value={d.messages.bounced} />
        <StatCard label={`Inbound (${window})`} value={d.messages.inbound_received} />
      </div>
    </div>
  );
}

export function Dashboard() {
  const [window, setWindow] = useState<'24h' | '7d' | '30d'>('24h');
  return (
    <PageCard
      decorative
      title="Dashboard"
      description="Operational overview. Backed by GET /v1/admin/stats/overview."
    >
      <Tabs value={window} onValueChange={(v) => setWindow(v as '24h' | '7d' | '30d')}>
        <TabsList>
          <TabsTrigger value="24h">Last 24h</TabsTrigger>
          <TabsTrigger value="7d">Last 7d</TabsTrigger>
          <TabsTrigger value="30d">Last 30d</TabsTrigger>
        </TabsList>
        <TabsContent value="24h" className="mt-4">
          <WindowedCards window="24h" />
        </TabsContent>
        <TabsContent value="7d" className="mt-4">
          <WindowedCards window="7d" />
        </TabsContent>
        <TabsContent value="30d" className="mt-4">
          <WindowedCards window="30d" />
        </TabsContent>
      </Tabs>
    </PageCard>
  );
}
