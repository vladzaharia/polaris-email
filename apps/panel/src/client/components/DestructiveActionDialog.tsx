// DestructiveActionDialog — reusable confirm-before-you-do-something-bad dialog.
//
// Wraps the shared Radix `Dialog` primitive in a destructive-action shape:
// blast-radius bullets, "cannot be undone" banner (by default), and an
// optional typed-confirmation gate that disables Confirm until the operator
// types the exact name of the thing they're about to destroy.
//
// Used across every destructive action in the panel: credential revoke, DKIM
// rotate, domain delete, bridge HMAC roll, bridge disable, DLQ drop,
// mailbox sender/receiver/inbound disable, webhook subscription delete.
import { useEffect, useRef, useState } from 'react';
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
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';

export interface DestructiveActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verb phrase describing the action, e.g. "Revoke credential". */
  action: string;
  /** Name of the thing being acted on, e.g. "smtp-acme-noreply". */
  name?: string;
  /** Bullet list describing what breaks when the action is taken. */
  blastRadius?: string[];
  /** When `false` (default), shows a "cannot be undone" banner. */
  reversible?: boolean;
  /**
   * When set, renders an `<Input>` and the Confirm button stays disabled
   * until the user types this exact string. Use for high-blast-radius
   * actions to prevent accidental "click through".
   */
  typedConfirmation?: string;
  /** Label for the confirm button. Defaults to `action`. */
  confirmLabel?: string;
  /** Called when the operator presses Confirm. May return a Promise. */
  onConfirm: () => void | Promise<void>;
  /** When true, Confirm shows a busy state and is disabled. */
  isPending?: boolean;
}

export function DestructiveActionDialog({
  open,
  onOpenChange,
  action,
  name,
  blastRadius,
  reversible = false,
  typedConfirmation,
  confirmLabel,
  onConfirm,
  isPending = false,
}: DestructiveActionDialogProps) {
  const [typed, setTyped] = useState('');
  const confirmInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the typed-confirmation field whenever the dialog reopens, so a
  // previous attempt doesn't leak its confirmation text into the next one.
  // Also focus the field on open so keyboard-first operators can start
  // typing immediately. (Phase 6c.4)
  useEffect(() => {
    if (open) {
      setTyped('');
      // Defer focus until after Radix mounts the dialog content. A tick is
      // enough; without it the ref is still null because Radix hasn't
      // portalled the input into the DOM yet.
      const t = setTimeout(() => {
        confirmInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const typedOk = !typedConfirmation || typed === typedConfirmation;
  const canConfirm = !isPending && typedOk;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action}</DialogTitle>
          <DialogDescription>
            Are you sure you want to {action.toLowerCase()}
            {name ? ` "${name}"` : ''}?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {blastRadius && blastRadius.length > 0 ? (
            <div>
              <p className="text-sm font-medium">This will:</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-[var(--color-muted-foreground)]">
                {blastRadius.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {!reversible ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-[var(--color-destructive)] bg-[var(--color-destructive)]/10 p-3 text-sm text-[var(--color-destructive)]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>This action cannot be undone.</span>
            </div>
          ) : null}

          {typedConfirmation ? (
            <div>
              <Label htmlFor="destructive-confirm">
                Type <code className="font-mono">{typedConfirmation}</code> to confirm
              </Label>
              <Input
                id="destructive-confirm"
                ref={confirmInputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={!typedOk && typed.length > 0}
                aria-describedby="destructive-confirm-hint"
                className="mt-1 font-mono"
              />
              <span id="destructive-confirm-hint" className="sr-only">
                Confirm by typing the literal string {typedConfirmation}.
              </span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              if (!canConfirm) return;
              void onConfirm();
            }}
            disabled={!canConfirm}
          >
            {isPending ? `${confirmLabel ?? action}…` : (confirmLabel ?? action)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
