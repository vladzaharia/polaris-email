// CodeBlock — monospace `<pre>` with copy-to-clipboard. Phase I adds syntax
// highlighting (likely Shiki via a small worker bundle).
import { useState } from 'react';

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre className="relative rounded-md border bg-[var(--color-muted)] p-4 font-mono text-xs">
      <code data-language={language}>{code}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 text-xs opacity-60 hover:opacity-100"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </pre>
  );
}
