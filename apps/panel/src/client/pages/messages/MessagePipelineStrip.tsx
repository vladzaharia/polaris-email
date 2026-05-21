// Per-message pipeline strip rendered on MessageDetail.
//
// For an outbound message the canonical flow is
//   queued → sending → sent → delivered
// with optional terminal branches `failed` and `bounced` rendered as a
// destructive-tinted side tile. For inbound the flow is
//   received → policy → fanout
// where `policy` is hydrated from `/api/admin/policy/decisions?message_id=`
// (block/hold verdicts surface as warning/destructive) and `fanout` reads
// the live `/api/admin/webhook-dlq?message_id=` count. Both side queries
// are hints: `staleTime: 30_000` and they don't gate render of the strip.
//
// Visual treatment:
//   - past stages render with a success tint
//   - the current stage renders with the primary tint
//   - future stages render as muted outlines
//   - failed / bounced render as a destructive tile and short-circuit the
//     happy path (everything after the current stage drops to "future")
import { Link } from '@tanstack/react-router';
import type { ComponentType, SVGProps } from 'react';
import {
  ArrowRight,
  CheckCheck,
  Clock,
  Gavel,
  Inbox,
  MailCheck,
  Send,
  Share2,
  Undo2,
  XCircle,
} from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { policyKeys, dlqKeys } from '../../queryKeys.js';

type Tone = 'past' | 'current' | 'future' | 'terminal-error';

interface PipelineTile {
  key: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: Tone;
  subtext?: string;
  // Either a typed router target (preferred for known static routes) or a
  // plain href when we need to pass a hint query string the route doesn't
  // validate. Both render with focus-visible affordances.
  to?: '/policy/decisions' | '/dlq';
  href?: string;
}

const TONE_CLASS: Record<Tone, string> = {
  // success-tinted filled tile for completed stages
  past: 'border-[color-mix(in_oklch,var(--color-success)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-success)_15%,var(--color-card))] text-[var(--color-foreground)]',
  // primary-tinted filled tile for the live stage
  current:
    'border-[var(--color-primary)] bg-[color-mix(in_oklch,var(--color-primary)_18%,var(--color-card))] text-[var(--color-foreground)] shadow-sm',
  // muted outline for not-yet-reached stages
  future: 'border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)]',
  // destructive-tinted filled tile for failed/bounced/blocked
  'terminal-error':
    'border-[var(--color-destructive)] bg-[color-mix(in_oklch,var(--color-destructive)_18%,var(--color-card))] text-[var(--color-foreground)]',
};

const OUT_STAGES = ['queued', 'sending', 'sent', 'delivered'] as const;
const OUT_ICONS: Record<(typeof OUT_STAGES)[number], ComponentType<SVGProps<SVGSVGElement>>> = {
  queued: Clock,
  sending: Send,
  sent: CheckCheck,
  delivered: MailCheck,
};

interface PolicyDecisionRow {
  id: string;
  verdict: string;
}
interface DlqRow {
  id: string;
}

function Tile({ tile }: { tile: PipelineTile }) {
  const Icon = tile.icon;
  const body = (
    <div
      className={cn(
        'flex h-full w-[120px] flex-col items-center justify-center gap-1 rounded-md border px-2 py-3 text-center transition-colors',
        TONE_CLASS[tile.tone],
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
      <span className="text-xs font-medium leading-tight">{tile.label}</span>
      {tile.subtext ? (
        <span className="text-[10px] leading-tight opacity-80">{tile.subtext}</span>
      ) : null}
    </div>
  );
  const linkClass =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] focus-visible:rounded-md';
  if (tile.to) {
    return (
      <Link to={tile.to} aria-label={`${tile.label} — open details`} className={linkClass}>
        {body}
      </Link>
    );
  }
  if (tile.href) {
    return (
      <a href={tile.href} aria-label={`${tile.label} — open details`} className={linkClass}>
        {body}
      </a>
    );
  }
  return body;
}

function Connector() {
  return (
    <div className="flex flex-1 items-center justify-center" aria-hidden>
      <div className="h-px w-full min-w-4 bg-[var(--color-border)]" />
      <ArrowRight className="h-3 w-3 shrink-0 text-[var(--color-muted-foreground)]" />
      <div className="h-px w-full min-w-4 bg-[var(--color-border)]" />
    </div>
  );
}

function buildOutboundTiles(status: string): PipelineTile[] {
  const lower = status.toLowerCase();
  const terminal = lower === 'failed' || lower === 'bounced';
  // The happy-path index is the furthest stage on the OUT_STAGES axis that
  // the message reached. For terminal states we treat the prior stage as
  // "past" so the failure tile slots in cleanly.
  let currentIdx = OUT_STAGES.indexOf(lower as (typeof OUT_STAGES)[number]);
  if (terminal) {
    // failed/bounced commonly fire after `sending`; show `queued`+`sending`
    // as past and the terminal tile as current.
    currentIdx = OUT_STAGES.indexOf('sending');
  }
  if (currentIdx < 0) currentIdx = 0;

  const happyTiles: PipelineTile[] = OUT_STAGES.map((stage, idx) => {
    let tone: Tone;
    if (terminal) {
      // Everything up to and including `sending` is past; nothing else is
      // current — the terminal tile owns "current".
      tone = idx <= currentIdx ? 'past' : 'future';
    } else if (idx < currentIdx) tone = 'past';
    else if (idx === currentIdx) tone = 'current';
    else tone = 'future';
    return {
      key: stage,
      label: stage,
      icon: OUT_ICONS[stage],
      tone,
    };
  });

  if (!terminal) return happyTiles;

  const terminalTile: PipelineTile = {
    key: lower,
    label: lower,
    icon: lower === 'bounced' ? Undo2 : XCircle,
    tone: 'terminal-error',
    ...(lower === 'bounced' ? { subtext: 'remote rejected' } : { subtext: 'send failed' }),
  };
  return [...happyTiles, terminalTile];
}

interface InboundMeta {
  policyVerdict: string | null;
  dlqCount: number;
}

function buildInboundTiles(messageId: string, status: string, meta: InboundMeta): PipelineTile[] {
  // For inbound, `received` is effectively always reached as long as we
  // have a `messages` row. `policy` is past if we saw a verdict; `fanout`
  // is past if we saw an outcome from the queue consumer.
  const lower = status.toLowerCase();
  const receivedTone: Tone = lower === 'received' ? 'past' : 'past';

  // Policy tile tone:
  //   - block → destructive terminal
  //   - hold  → destructive terminal (operator action needed)
  //   - other verdicts → past (allowed/accepted)
  //   - missing verdict → current (still scoring) when status==='received'
  let policyTone: Tone = 'past';
  let policySubtext: string | undefined;
  if (meta.policyVerdict === 'block') {
    policyTone = 'terminal-error';
    policySubtext = 'blocked';
  } else if (meta.policyVerdict === 'hold') {
    policyTone = 'terminal-error';
    policySubtext = 'held';
  } else if (meta.policyVerdict == null) {
    policyTone = 'current';
    policySubtext = 'pending';
  } else {
    policySubtext = meta.policyVerdict;
  }

  // Fanout tile: if policy blocked/held the message never makes it here, so
  // mark fanout as future; otherwise the DLQ count drives the tone.
  let fanoutTone: Tone;
  let fanoutSubtext: string | undefined;
  if (policyTone === 'terminal-error') {
    fanoutTone = 'future';
  } else if (meta.dlqCount > 0) {
    fanoutTone = 'terminal-error';
    fanoutSubtext = `${meta.dlqCount} in DLQ`;
  } else {
    fanoutTone = 'past';
    fanoutSubtext = 'delivered';
  }

  return [
    {
      key: 'received',
      label: 'received',
      icon: Inbox,
      tone: receivedTone,
    },
    {
      key: 'policy',
      label: 'policy',
      icon: Gavel,
      tone: policyTone,
      ...(policySubtext ? { subtext: policySubtext } : {}),
      // No per-decision detail page; link to the decisions list with the
      // message id rendered as a hint via raw query string (the
      // /policy/decisions route doesn't validateSearch so we can't pass
      // through TanStack `search`).
      href: `/policy/decisions?message_id=${encodeURIComponent(messageId)}`,
    },
    {
      key: 'fanout',
      label: 'fanout',
      icon: Share2,
      tone: fanoutTone,
      ...(fanoutSubtext ? { subtext: fanoutSubtext } : {}),
      to: '/dlq',
    },
  ];
}

export function MessagePipelineStrip({
  messageId,
  direction,
  status,
}: {
  messageId: string;
  direction: 'in' | 'out';
  status: string;
}) {
  // Side queries — only fire for inbound, where the strip surfaces both
  // verdict + DLQ count. `staleTime` matches the doc-stated 30s hint window.
  const policyQ = useAdminQuery<{ data: PolicyDecisionRow[] }>(
    [...policyKeys.decisions({ message_id: messageId })],
    `/api/admin/policy/decisions?message_id=${encodeURIComponent(messageId)}`,
    { enabled: direction === 'in', staleTime: 30_000 },
  );
  const dlqQ = useAdminQuery<{ data: DlqRow[] }>(
    [...dlqKeys.list(), 'by-message', messageId] as const,
    `/api/admin/webhook-dlq?message_id=${encodeURIComponent(messageId)}`,
    { enabled: direction === 'in', staleTime: 30_000 },
  );

  const tiles: PipelineTile[] =
    direction === 'out'
      ? buildOutboundTiles(status)
      : buildInboundTiles(messageId, status, {
          policyVerdict: policyQ.data?.data?.[0]?.verdict ?? null,
          dlqCount: dlqQ.data?.data?.length ?? 0,
        });

  return (
    <section
      aria-label="Message pipeline"
      className="flex items-stretch gap-2 overflow-x-auto py-2"
    >
      {tiles.map((tile, idx) => (
        <div key={tile.key} className="flex items-stretch gap-2">
          {idx > 0 ? <Connector /> : null}
          <Tile tile={tile} />
        </div>
      ))}
    </section>
  );
}
