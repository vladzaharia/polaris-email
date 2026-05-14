// MessageJsonView — renders a Message JSON envelope with collapsible headers,
// text/html body tabs, and an attachments table. Used by /messages/:id.
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './ui/accordion.js';
import { CodeBlock } from './CodeBlock.js';

interface MinimalMessage {
  headers?: Record<string, string>;
  bodies?: {
    text?: { inline?: string; url?: string };
    html?: { inline?: string; url?: string };
  };
}

export function MessageJsonView({ message }: { message: unknown }) {
  const m = (message ?? {}) as MinimalMessage;
  return (
    <div className="space-y-4">
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
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="text">
          <pre className="whitespace-pre-wrap text-sm">{m.bodies?.text?.inline ?? '(empty)'}</pre>
        </TabsContent>
        <TabsContent value="html">
          {m.bodies?.html?.inline ? (
            <iframe
              title="html body"
              srcDoc={m.bodies.html.inline}
              className="h-96 w-full rounded-md border"
              sandbox=""
            />
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">No HTML body.</p>
          )}
        </TabsContent>
        <TabsContent value="raw">
          <CodeBlock code={JSON.stringify(message, null, 2)} language="json" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
