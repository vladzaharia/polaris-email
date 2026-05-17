// Message detail — renders the canonical Message JSON via MessageJsonView,
// plus an attachments table whose Download buttons link straight to the R2
// public custom domain. No signed-URL mint round-trip.
import { useParams } from '@tanstack/react-router';
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
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '../../components/ui/accordion.js';
import { useAdminQuery } from '../../hooks/useAdminApi.js';
import { messageKeys } from '../../queryKeys.js';

interface MessagePayload {
  id: string;
  direction: 'in' | 'out';
  status: string;
  from: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  // Public R2 URL for the raw RFC822 body.
  body_url?: string;
  headers?: Record<string, string>;
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

export function MessageDetail() {
  const { id } = useParams({ from: '/messages/$id' });
  const q = useAdminQuery<MessagePayload>(messageKeys.detail(id), `/api/messages/${id}`);
  const breadcrumbs = [
    { label: 'Messages', to: '/messages' },
    { label: q.data?.subject ?? id.slice(0, 12) },
  ];
  if (q.isLoading) {
    return (
      <PageCard title="Message" breadcrumbs={breadcrumbs}>
        <Skeleton className="h-32 w-full" />
      </PageCard>
    );
  }
  if (q.error || !q.data) {
    return (
      <PageCard title="Message" breadcrumbs={breadcrumbs}>
        <p className="text-sm text-[var(--color-destructive)]">
          {q.error?.message ?? 'Not found.'}
        </p>
      </PageCard>
    );
  }
  const m = q.data;
  const textInline = m.text ?? m.bodies?.text?.inline;
  const htmlInline = m.html ?? m.bodies?.html?.inline;
  // Body URL preference: the B5 `body_url` (full RFC822 on R2) takes precedence;
  // fall back to the legacy per-mime bridge-style URLs if they're still around.
  const bodyHref = m.body_url ?? m.bodies?.text?.url ?? m.bodies?.html?.url;
  return (
    <PageCard
      title={m.subject ?? '(no subject)'}
      breadcrumbs={breadcrumbs}
      description={`${m.direction} · ${m.status}`}
      decorative
    >
      <div className="space-y-6">
        <div className="text-sm">
          <div>
            <strong>From:</strong> {m.from}
          </div>
          <div>
            <strong>To:</strong> {m.to.join(', ')}
          </div>
        </div>

        {m.headers ? (
          <Accordion type="single" collapsible>
            <AccordionItem value="headers">
              <AccordionTrigger>Headers</AccordionTrigger>
              <AccordionContent>
                <pre className="overflow-auto text-xs">
                  {Object.entries(m.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n')}
                </pre>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : null}

        <Tabs defaultValue="text">
          <TabsList>
            <TabsTrigger value="text">Text</TabsTrigger>
            <TabsTrigger value="html">HTML</TabsTrigger>
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
