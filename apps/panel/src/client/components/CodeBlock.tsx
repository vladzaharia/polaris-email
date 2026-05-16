// CodeBlock — monospace `<pre>` with copy-to-clipboard.
//
// TODO(phase-6e.2): when syntax highlighting is added (likely Shiki), the
// highlighter MUST be dynamic-imported so the ~600KB worker bundle doesn't
// land in the main chunk. Sketch:
//   const { codeToHtml } = await import('shiki/bundle/web');
// Use a lazy effect to swap `<code>{code}</code>` with the highlighter
// output once it resolves.
import { useState } from 'react';
import { Button } from './ui/button.js';

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre className="relative rounded-md border bg-[var(--color-muted)] p-4 font-mono text-xs">
      <code data-language={language}>{code}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 h-7 px-2 text-xs opacity-60 hover:opacity-100"
      >
        {copied ? 'copied' : 'copy'}
      </Button>
    </pre>
  );
}
