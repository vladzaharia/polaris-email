// Message detail.
//
// Renders the canonical Message JSON returned by `GET /api/messages/:id`
// alongside a per-message <MessagePipelineStrip> that surfaces queue/policy/
// fanout state at a glance. Attachment Download buttons link straight to the
// public R2 custom domain — no signed-URL mint round-trip.
import { useParams, Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { PageCard } from '../../layouts/PageCard.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Button } from '../../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { messageKeys } from '../../queryKeys.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { ErrorText } from '../../components/ErrorText.js';
import { formatDate, formatRelative } from '../../lib/format.js';
import { MessagePipelineStrip } from './MessagePipelineStrip.js';

interface MessagePayload {
  id: string;
  direction: 'in' | 'out';
  status: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  // Public R2 URL for the raw RFC822 body.
  body_url?: string;
  headers?: Record<string, string>;
  header_message_id?: string;
  mailbox_id?: string;
  created_at?: string;
  // Bridge-style payload shape for back-compat — kept as a fallback while
  // older callers still emit it.
  bodies?: {
    text?: { inline?: string; url?: string; bytes?: number };
    html?: { inline?: string; url?: string; bytes?: number };
  };
  attachments?: Array<{
    filename: string;
    content_type: string;
    size_bytes?: number;
    bytes?: number;
    // Public R2 URL for the attachment bytes.
    url?: string;
  }>;
}

// Definition-list cell: `<dt>` muted small, `<dd>` reads as foreground.
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </>
  );
}

export function MessageDetail() {
  const { id } = useParams({ from: '/messages/$id' });
  const q = useAdminQuery<MessagePayload>(messageKeys.detail(id), `/api/messages/${id}`);
  const breadcrumbs = [
    { label: 'Messages', to: '/messages' },
    { label: q.data?.subject ?? id.slice(0, 12) },
  ];
  if (q.isLoading) {
    return (
      <PageCard title="Message" breadcrumbs={breadcrumbs} decorative>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Message" breadcrumbs={breadcrumbs} decorative>
        <ErrorText error={q.error ?? 'Not found.'} />
      </PageCard>
    );
  }
  const m = q.data;
  const textInline = m.text ?? m.bodies?.text?.inline;
  const htmlInline = m.html ?? m.bodies?.html?.inline;
  // Body URL preference: the B5 `body_url` (full RFC822 on R2) takes precedence;
  // fall back to the legacy per-mime bridge-style URLs if they're still around.
  const bodyHref = m.body_url ?? m.bodies?.text?.url ?? m.bodies?.html?.url;
  const createdRelative = m.created_at ? formatRelative(m.created_at) : null;
  return (
    <PageCard
      title={m.subject ?? '(no subject)'}
      breadcrumbs={breadcrumbs}
      description={
        <span className="inline-flex items-center gap-2">
          <span className="uppercase tracking-wide">{m.direction}</span>
          <span aria-hidden>·</span>
          <StatusBadge kind="message" value={m.status} />
          {createdRelative ? (
            <>
              <span aria-hidden>·</span>
              <span>{createdRelative}</span>
            </>
          ) : null}
        </span>
      }
      decorative
    >
      <div className="space-y-6">
        {/* Metadata grid — two-column definition list with a max-content
            label column so multi-line "to:" lists wrap cleanly. */}
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
          <MetaRow label="From">
            <span className="font-mono text-xs">{m.from}</span>
          </MetaRow>
          <MetaRow label="To">
            <span className="font-mono text-xs">{m.to.join(', ')}</span>
          </MetaRow>
          {m.cc && m.cc.length > 0 ? (
            <MetaRow label="Cc">
              <span className="font-mono text-xs">{m.cc.join(', ')}</span>
            </MetaRow>
          ) : null}
          {m.mailbox_id ? (
            <MetaRow label="Mailbox">
              <Link
                to="/mailboxes/$id"
                params={{ id: m.mailbox_id }}
                className="font-mono text-xs underline-offset-2 hover:underline"
              >
                {m.mailbox_id}
              </Link>
            </MetaRow>
          ) : null}
          {m.header_message_id ? (
            <MetaRow label="Message-ID">
              <span className="font-mono text-xs">{m.header_message_id}</span>
            </MetaRow>
          ) : null}
          {m.created_at ? (
            <MetaRow label="Created">
              <span className="text-sm">
                {formatDate(m.created_at)}{' '}
                <span className="text-[var(--color-muted-foreground)]">
                  ({formatRelative(m.created_at)})
                </span>
              </span>
            </MetaRow>
          ) : null}
          {bodyHref ? (
            <MetaRow label="Raw">
              <a
                href={bodyHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-[var(--color-primary)] underline-offset-2 hover:underline"
              >
                RFC822 source <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </MetaRow>
          ) : null}
        </dl>

        <MessagePipelineStrip messageId={m.id} direction={m.direction} status={m.status} />

        <Tabs defaultValue="text">
          <TabsList>
            <TabsTrigger value="text">Text</TabsTrigger>
            <TabsTrigger value="html">HTML</TabsTrigger>
            <TabsTrigger value="headers">Headers</TabsTrigger>
          </TabsList>
          <TabsContent value="text" className="mt-3">
            {textInline ? (
              <pre className="whitespace-pre-wrap text-sm">{textInline}</pre>
            ) : bodyHref ? (
              <Button asChild size="sm" variant="outline">
                <a href={bodyHref}>Download raw RFC822</a>
              </Button>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">No text body.</p>
            )}
          </TabsContent>
          <TabsContent value="html" className="mt-3">
            {htmlInline ? (
              <iframe
                title="html body"
                srcDoc={htmlInline}
                className="h-96 w-full rounded-md border"
                sandbox=""
              />
            ) : bodyHref ? (
              <Button asChild size="sm" variant="outline">
                <a href={bodyHref}>Download raw RFC822</a>
              </Button>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">No HTML body.</p>
            )}
          </TabsContent>
          <TabsContent value="headers" className="mt-3">
            {m.headers && Object.keys(m.headers).length > 0 ? (
              <pre className="overflow-auto rounded-md border bg-[var(--color-muted)]/30 p-3 text-xs">
                {Object.entries(m.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              </pre>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">No headers captured.</p>
            )}
          </TabsContent>
        </Tabs>

        <section>
          <h2 className="mb-2 text-xl font-medium">Attachments</h2>
          {(m.attachments ?? []).length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">None.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Filename</TableHead>
                  <TableHead>Content-Type</TableHead>
                  <TableHead>Bytes</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(m.attachments ?? []).map((a, i) => (
                  <TableRow key={`${a.filename}:${i}`}>
                    <TableCell>{i}</TableCell>
                    <TableCell>{a.filename}</TableCell>
                    <TableCell className="font-mono text-xs">{a.content_type}</TableCell>
                    <TableCell>{a.size_bytes ?? a.bytes}</TableCell>
                    <TableCell>
                      {a.url ? (
                        <Button asChild size="sm" variant="outline">
                          <a href={a.url} target="_blank" rel="noopener noreferrer">
                            Download
                          </a>
                        </Button>
                      ) : (
                        <span className="text-xs text-[var(--color-muted-foreground)]">No URL</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </PageCard>
  );
}
