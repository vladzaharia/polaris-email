// SecretRevealDialog — one-shot read-once secret reveal.
//
// Used when the API mints a secret that the schema does NOT store in
// plaintext (API key secrets, SMTPS passwords, bridge HMAC keys). The plan
// (A11/B6) makes secrets read-once: there is no out-of-band path to fetch
// them again, so this dialog has to give the operator a clear copy moment
// and then close.
//
// IMPORTANT: this component does not re-fetch the secret. It is passed in
// once as a prop. Closing the dialog calls `onOpenChange(false)`; the parent
// is responsible for clearing whatever state held the secret so subsequent
// renders pass `secret={null}`.
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { CodeBlock } from './CodeBlock.js';
import { toast } from './ui/sonner.js';

export interface SecretRevealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog header, e.g. "New credential created". */
  title: string;
  /** Inline label above the secret block. Defaults to "Secret". */
  secretLabel?: string;
  /** The secret to display. `null` means nothing to show (dialog closed). */
  secret: string | null;
  /** Optional context shown below the secret, e.g. "Use this for SMTPS LOGIN". */
  note?: string;
}

export function SecretRevealDialog({
  open,
  onOpenChange,
  title,
  secretLabel = 'Secret',
  secret,
  note,
}: SecretRevealDialogProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success('Copied secret to clipboard');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Failed to copy. Select the text and copy manually.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{secretLabel} below. Treat it like a password.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-[var(--color-destructive)] bg-[var(--color-destructive)]/10 p-3 text-sm text-[var(--color-destructive)]"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>This is the only time you&apos;ll see this value. Copy it now.</span>
          </div>

          {secret ? (
            <div>
              <p className="mb-1 text-sm font-medium">{secretLabel}</p>
              <CodeBlock code={secret} />
            </div>
          ) : null}

          <Button size="sm" type="button" variant="outline" onClick={copy} disabled={!secret}>
            {copied ? 'Copied' : 'Copy'}
          </Button>

          {note ? <p className="text-sm text-[var(--color-muted-foreground)]">{note}</p> : null}
        </div>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            I&apos;ve saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
