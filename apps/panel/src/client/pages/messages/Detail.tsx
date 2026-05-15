// Message detail — renders the canonical Message JSON via MessageJsonView,
// plus an attachments table whose Download buttons call the signed-URL mint
// endpoint and navigate the user to the resulting URL.
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
  headers?: Record<string, string>;
  bodies?: {
    text?: { inline?: string; url?: string; bytes?: number };
    html?: { inline?: string; url?: string; bytes?: number };
  };
  attachments?: Array<{ filename: string; content_type: string; bytes: number }>;
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
  const textInline = m.bodies?.text?.inline;
  const htmlInline = m.bodies?.html?.inline;
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
            ) : m.bodies?.text?.url ? (
              <Button asChild size="sm" variant="outline">
                <a href={m.bodies.text.url}>Download text body</a>
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
            ) : m.bodies?.html?.url ? (
              <Button asChild size="sm" variant="outline">
                <a href={m.bodies.html.url}>Download HTML body</a>
              </Button>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">No HTML body.</p>
            )}
          </TabsContent>
        </Tabs>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Attachments</h2>
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
                    <TableCell>{a.bytes}</TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/messages/${id}/attachments/${i}`}>Download</a>
                      </Button>
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
